const { ethers, Wallet, Signer } = require("ethers");
const abi = require("./abis/LlamaPayBot.json");
require("dotenv").config();

const chains = ["goerli"];

const rpcs = {
  goerli: `https://goerli.infura.io/v3/${process.env.INFURA_KEY}`,
};

const contractAddresses = {
  goerli: "0xdE7c52F1049ea7Cc7D20aF4708e6566994830807",
};

const topics = {
  "0x2964df00d05d867fb39d81ec5ed1d5ab5125691de320bbc5cfc5faf7a5505369":
    "WithdrawScheduled",
  "0x2d7e851ad23abc91818637874db4164af53ae6d837db0c7d96f847a556ab2f69":
    "WithdrawCancelled",
  "0xf02b6913a0661fd5a19a298c7bac40f63b16c538b8799cf36812e1224e2e9c60":
    "WithdrawExecuted",
};

async function run(chain) {
  const rpc = rpcs[chain];
  const contractAddress = contractAddresses[chain];
  const provider = new ethers.providers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const contract = new ethers.Contract(contractAddress, abi, provider);
  const interface = contract.interface;
  const scheduleFilter = contract.filters.WithdrawScheduled();
  const cancelFilter = contract.filters.WithdrawCancelled();
  const executeFilter = contract.filters.WithdrawExecuted();
  const events = await contract.queryFilter([
    scheduleFilter,
    cancelFilter,
    executeFilter,
  ]);
  const endTimestamp =
    new Date(new Date(Date.now()).toISOString().slice(0, 10)).getTime() / 1e3;
  const startTimestamp = endTimestamp - 86400;
  const scheduleEvents = {};
  for (let i = 0; i < events.length; i++) {
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
    const id = data[7];
    if (scheduleEvents[id] === undefined) {
      scheduleEvents[id] = [];
    }
    scheduleEvents[id].push({
      block: events[i].blockNumber,
      topic: topics[events[i].topics[0]],
      owner: data[0],
      llamaPay: data[1],
      from: data[2],
      to: data[3],
      amountPerSec: data[4],
      starts: data[5],
      frequency: data[6],
    });
  }
  const toExecute = {};
  for (const id in scheduleEvents) {
    const last = scheduleEvents[id][scheduleEvents[id].length - 1];
    if (last.topic === "WithdrawExecuted") {
      const timestamp = (await provider.getBlock(last.block)).timestamp;
      const toUpdate = timestamp + last.frequency;
      if (toUpdate >= startTimestamp && toUpdate <= endTimestamp) {
        const data = interface.encodeFunctionData("executeWithdraw", [
          last.owner,
          last.llamaPay,
          last.from,
          last.to,
          last.amountPerSec,
          last.starts,
          last.frequency,
        ]);
        toExecute[last.owner] === undefined
          ? (toExecute[last.owner] = [data])
          : toExecute[last.owner].push(data);
      }
    } else if (last.topic === "WithdrawScheduled" >= endTimestamp) {
      const data = interface.encodeFunctionData("executeWithdraw", [
        last.owner,
        last.llamaPay,
        last.from,
        last.to,
        last.amountPerSec,
        last.starts,
        last.frequency,
      ]);
      toExecute[last.owner] === undefined
        ? (toExecute[last.owner] = [data])
        : toExecute[last.owner].push(data);
    }
  }
  const calls = [];
  for (const owner in toExecute) {
    const data = interface.encodeFunctionData("executeTransactions", [
      toExecute[owner],
      owner,
    ]);
    calls.push(data);
  }
  if (calls.length > 0) {
    await contract.connect(wallet).batch(calls, {
      gasLimit: 500000,
    });
  }
}

async function main() {
  chains.forEach((chain) => {
    run(chain);
  });
}

main();
