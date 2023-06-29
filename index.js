const {
  createPublicClient,
  createWalletClient,
  webSocket,
  encodePacked,
  keccak256,
  parseEther
} = require('viem');
const { mainnet } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');
const ethers = require('ethers');

const CONFIG = require('./config.json');

const DOOMSDAY_ABI = require('./abis/doomsday.json');
const DOOMSDAY_ADDRESS = '0xb4cba31bdaf6ff6e34efc0cfc4906bd29b0146e9';
const SETTLE_TOPIC = '0xbf6a0a18cb8b34e66dceac63a664d56b954595faa49f2a9c2c1f94d878fb6ce1';
const BASE_DIFFICULTY = 38597363079105398474523661669562635951089994888546854679819194669304376n;
const DIFFICULTY_RAMP = 15000n;
const DIFFICULTY_COOLDOWN = 25n;
const DIFFICULTY_COOLDOWN_SLOPE = 15n;

const { user } = CONFIG;
const account = privateKeyToAccount(user.pkey);
const transport = webSocket(CONFIG.ws);

const client = createPublicClient({
  chain: mainnet,
  transport
});

const wallet = createWalletClient({
  account,
  chain: mainnet,
  transport
})

client.watchBlockNumber({
  onBlockNumber: block => monitorDoomsday(block)
});

let lastHash, lastSettleBlock, currentBlock, supply, location, solutionNum, difficulty;

async function monitorDoomsday(blockNumber) {
  console.log(`parseBlockNumber: ${blockNumber}`);

  currentBlock = blockNumber;
  const block = await client.getBlock({ blockNumber });
  const events = await client.getLogs({ blockHash: block.hash });

  const doomsdayContract = {
    address: DOOMSDAY_ADDRESS,
    abi: DOOMSDAY_ABI
  };

  const results = await client.multicall({
    contracts: [
      {
        ...doomsdayContract,
        functionName: 'getLastHash'
      },
      {
        ...doomsdayContract,
        functionName: 'totalSupply'
      }
    ]
  });

  lastHash = results[0].result;
  supply = results[1].result;

  const encodedSettleEvent = getSettleEvent(events);
  if (encodedSettleEvent) {
    console.log('SETTLE EVENT FOUND');
    lastSettleBlock = blockNumber;
    location = 1n;
    mine(lastSettleBlock);
  }
};

function getSettleEvent(events) {
  return events.find(event => event.address === DOOMSDAY_ADDRESS && event.topics[0] === SETTLE_TOPIC);
}

function mine(blockStarted) {
  console.log(`start mining: ${blockStarted}`);

  return new Promise((resolve) => {
    const mineLoop = async () => {
      while (true) {
        if (blockStarted !== lastSettleBlock) {
          console.log(`end mining: ${blockStarted}`);
          resolve();
          return;
        }

        const hash = keccak256(encodePacked(['address', 'bytes32', 'uint256'], [user.address, lastHash, location]));
        solutionNum = ethers.BigNumber.from(hash);

        difficulty = BASE_DIFFICULTY - (DIFFICULTY_RAMP * supply);
        const blockDif = (currentBlock - lastSettleBlock);

        if (blockDif < DIFFICULTY_COOLDOWN) {
          difficulty /= DIFFICULTY_COOLDOWN_SLOPE * (DIFFICULTY_COOLDOWN - blockDif);
        }

        if (solutionNum < difficulty) {
          console.log('SOLUTION FOUND');
          const { request } = await client.simulateContract({
            address: DOOMSDAY_ADDRESS,
            abi: DOOMSDAY_ABI,
            functionName: 'settle',
            args: [location],
            account
          });
          await wallet.writeContract(request);
          resolve();
          return;
        }

        printStatus(`Location: ${location.toString()}`);
        location++;

        // Delay the loop iteration to yield to other tasks every 100,000th location
        if (location % 100000n === 0n) await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };

    mineLoop();
  });
}

function printStatus(status) {
  process.stdout.write(`${status}\r`);
}
