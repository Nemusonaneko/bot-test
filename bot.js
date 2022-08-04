const { ethers } = require("ethers");
const abi = require("./abis/LlamaPayBot.json");
const { gql, request } = require("graphql-request");
require("dotenv").config();

const chains = ["goerli"];

const rpcs = {
  goerli: `https://goerli.infura.io/v3/${process.env.INFURA_KEY}`,
};

const graphapi = {
  goerli:
    "https://api.thegraph.com/subgraphs/name/nemusonaneko/llamapay-goerli",
};

const chainIds = {
  goerli: 5,
  avalanche: 43114,
};

const contractAddresses = {
  goerli: "0xAF86436289454f0D862160b914BFE768bCcF9920",
};

const blockCreated = {
  goerli: 7343399,
};

const topics = {
  "0x2964df00d05d867fb39d81ec5ed1d5ab5125691de320bbc5cfc5faf7a5505369":
    "WithdrawScheduled",
  "0x2d7e851ad23abc91818637874db4164af53ae6d837db0c7d96f847a556ab2f69":
    "WithdrawCancelled",
  "0xf02b6913a0661fd5a19a298c7bac40f63b16c538b8799cf36812e1224e2e9c60":
    "WithdrawExecuted",
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
    const endTimestamp =
      new Date(new Date(Date.now()).toISOString().slice(0, 10)).getTime() / 1e3;
    const startTimestamp = endTimestamp - 86400;
    const scheduleEvents = {};
    for (const i in events) {
      const data = ethers.utils.defaultAbiCoder.decode(
        [
          "address",
          "address",
          "address",
          "address",
          "uint216",
          "uint40",
          "uint40",
          "bytes32",
        ],
        events[i].data
      );
      const block = events[i].blockNumber;
      const topic = topics[events[i].topics[0]];
      const owner = data[0];
      const llamaPay = data[1];
      const from = data[2];
      const to = data[3];
      const amountPerSec = data[4];
      const starts = data[5];
      const frequency = data[6];
      const id = data[7];
      if (scheduleEvents[id] === undefined) {
        scheduleEvents[id] = [];
      }
      scheduleEvents[id].push({
        block,
        topic,
        owner,
        llamaPay,
        from,
        to,
        amountPerSec,
        starts,
        frequency,
      });
    }
    const toExecute = {};
    for (const i in scheduleEvents) {
      const last = scheduleEvents[i][scheduleEvents[i].length - 1];
      if (
        (last.topic !== "WithdrawScheduled" &&
          last.topic !== "WithdrawExecuted") ||
        last.starts > endTimestamp
      )
        continue;
      if (last.topic === "WithdrawExecuted") {
        const timestamp = (await provider.getBlock(last.block)).timestamp;
        const toUpdate = timestamp + last.frequency;
        if (toUpdate < startTimestamp || toUpdate > endTimestamp) continue;
      }
      let query;
      if (
        last.llamaPay === zeroAdd &&
        last.to === zeroAdd &&
        Number(last.amountPerSec) === 0
      ) {
        query = gql`{
          streams(where:{payer: "${last.owner.toLowerCase()}", active: true, paused: false}) {
                contract {
                  address
                }
                payee {
                  address
                }
                amountPerSec
              }
        }`;
      } else if (
        last.llamaPay === zeroAdd &&
        last.from === zeroAdd &&
        Number(last.amountPerSec) === 0
      ) {
        query = gql`{
          streams(where:{payee: "${last.owner.toLowerCase()}", active: true, paused: false}) {
                contract {
                  address
                }
                payer {
                  address
                }
                amountPerSec
              }
        }`;
      } else {
        const data = interface.encodeFunctionData("executeWithdraw", [
          last.owner,
          last.llamaPay,
          last.from,
          last.to,
          last.amountPerSec,
          last.starts,
          last.frequency,
        ]);
        if (toExecute[last.owner] === undefined) {
          toExecute[last.owner] = [data];
        } else {
          toExecute[last.owner].push(data);
        }
        continue;
      }
      const response = (await request(graphapi[chain], query)).streams;
      const calls = [];
      for (const j in response) {
        const res = response[j];
        calls.push(
          interface.encodeFunctionData("executeWithdraw", [
            last.owner,
            res.contract.address,
            last.from === zeroAdd ? res.payer.address : last.from,
            last.to === zeroAdd ? res.payee.address : last.to,
            res.amountPerSec,
            last.starts,
            last.frequency,
            false,
          ])
        );
      }
      calls.push(
        interface.encodeFunctionData("executeWithdraw", [
          last.owner,
          last.llamaPay,
          last.from === zeroAdd ? zeroAdd : last.from,
          last.to === zeroAdd ? zeroAdd : last.to,
          last.amountPerSec,
          last.starts,
          last.frequency,
          true,
        ])
      );
      if (toExecute[last.owner] === undefined) {
        toExecute[last.owner] = calls;
      } else {
        toExecute[last.owner] = toExecute[last.owner].concat(calls);
      }
    }
    const calls = [];
    const owners = [];
    for (const owner in toExecute) {
      const ownerBalance = await contract.balances(owner);
      const data = interface.encodeFunctionData("executeOwnerWithdrawal", [
        toExecute[owner],
        owner,
      ]);
      const gasCost = await provider.estimateGas({
        to: contractAddresses[chain],
        data: data,
      });
      if (Number(ownerBalance) >= Number(gasCost)) {
        calls.push(data);
        owners.push(owner);
      }
    }
    if (
      calls.length > 0 &&
      owners.length > 0 &&
      calls.length == owners.length
    ) {
      await contract
        .connect(signer)
        .batchExecuteOwnerWithdrawals(calls, owners, {
          gasLimit: 500000,
        });
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
