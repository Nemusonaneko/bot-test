const { ethers } = require("ethers");
const abi = require("./abis/LlamaPayBot.json");
const { gql, request } = require("graphql-request");
require("dotenv").config();

const chains = ["goerli"];

const rpcs = {
  goerli: `https://goerli.infura.io/v3/${process.env.INFURA_KEY}`,
};

const graphApi = {
  goerli:
    "https://api.thegraph.com/subgraphs/name/nemusonaneko/llamapay-goerli",
};

const chainIds = {
  goerli: 5,
};

const contractAddresses = {
  goerli: "0x469E31392F3c12b8624815Abc79a331838182aAe",
};

const blockCreated = {
  goerli: 7381991,
};

const zeroAdd = "0x0000000000000000000000000000000000000000";

async function run(chain) {
  try {
    const provider = new ethers.providers.StaticJsonRpcProvider(rpcs[chain], {
      name: chain,
      chainId: chainIds[chain],
    });
    const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const contract = new ethers.Contract(
      contractAddresses[chain],
      abi,
      provider
    );
    const interface = contract.interface;
    const endBlock = await provider.getBlockNumber();
    let currBlock = blockCreated[chain];
    const startTimestamp =
      new Date(new Date(Date.now()).toISOString().slice(0, 10)).getTime() / 1e3;
    const endTimestamp = startTimestamp + 86400;
    const filters = contract.filters;
    let events = [];
    do {
      const start = currBlock;
      if (currBlock + 1024 > endBlock) {
        currBlock = endBlock;
      } else {
        currBlock += 1024;
      }
      const queriedEvents = await contract.queryFilter(
        filters,
        start,
        currBlock
      );
      events = events.concat(queriedEvents);
    } while (currBlock < endBlock);
    const withdraws = {};
    for (const i in events) {
      const id = events[i].args.id;
      const newArray = withdraws[id] ?? [];
      newArray.push(events[i]);
      withdraws[id] = newArray;
    }
    const toExecute = {};
    for (const i in withdraws) {
      const last = withdraws[i][withdraws[i].length - 1];
      const args = last.args;
      if (last.event === "WithdrawCancelled") continue;
      if (args.starts > endTimestamp) continue;
      if (last.event === "WithdrawExecuted") {
        const timestamp = (await provider.getBlock(last.block)).timestamp;
        const toUpdate = timestamp + args.frequency;
        if (toUpdate < startTimestamp || toUpdate > endTimestamp) continue;
      }
      if (args.llamaPay !== zeroAdd) {
        const data = interface.encodeFunctionData("executeWithdraw", [
          args.owner,
          args.llamaPay,
          args.from,
          args.to,
          args.token,
          args.redirectTo,
          args.amountPerSec,
          args.starts,
          args.frequency,
          args.id,
          true,
          true,
        ]);
        const newArr = toExecute[args.owner] ?? [];
        newArr.push(data);
        toExecute[args.owner] = newArr;
      } else {
        const query = gql`{
          streams(where:{${
            args.from === zeroAdd ? "payee" : "payer"
          }: "${args.owner.toLowerCase()}", active: true, paused: false}) {
                contract {
                  address
                  token {
                    address
                  }
                }
                payer {
                  address
                }
                payee {
                  address
                }
                amountPerSec
              }
        }`;
        const queryRes = (await request(graphApi[chain], query)).streams;
        const calls = [];
        for (const j in queryRes) {
          const res = queryRes[j];
          calls.push(
            interface.encodeFunctionData("executeWithdraw", [
              args.owner,
              res.contract.address,
              res.payer.address,
              res.payee.address,
              res.contract.token.address,
              args.redirectTo,
              res.amountPerSec,
              args.starts,
              args.frequency,
              args.id,
              true,
              false,
            ])
          );
        }
        calls.push(
          interface.encodeFunctionData("executeWithdraw", [
            args.owner,
            args.llamaPay,
            args.from,
            args.to,
            args.token,
            args.redirectTo,
            args.amountPerSec,
            args.starts,
            args.frequency,
            args.id,
            false,
            true,
          ])
        );
        let newArr = toExecute[args.owner] ?? [];
        newArr = newArr.concat(calls);
        toExecute[args.owner] = newArr;
      }
      const calls = [];
      for (const i in toExecute) {
        const data = interface.encodeFunctionData("execute", [toExecute[i], i]);
        const bal = await contract.balances(i);
        const cost = await provider.estimateGas({
          from: "0xFE5eE99FDbcCFAda674A3b85EF653b3CE4656e13",
          to: contractAddresses[chain],
          data: data,
        });
        if (Number(bal) >= Number(cost)) {
          calls.push(data);
        }
      }
      if (calls.length > 0) {
        const data = interface.encodeFunctionData("batchExecute", [calls]);
        const cost = await provider.estimateGas({
          from: "0xFE5eE99FDbcCFAda674A3b85EF653b3CE4656e13",
          to: contractAddresses[chain],
          data: data,
        });
        await contract.connect(signer).batchExecute(calls, {
          gasLimit: Number(cost) + 1000000,
        });
      }
    }
  } catch (error) {
    console.log(error);
  }
}

async function main() {
  chains.forEach((chain) => {
    run(chain);
  });
}

main();
