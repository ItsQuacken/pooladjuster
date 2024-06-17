import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import bs58 from "bs58";
import BN from "bn.js";
import axios from "axios";

const secretKey =
  "YOUR_PRIVATE_KEY";
const userKeypair = Keypair.fromSecretKey(bs58.decode(secretKey));
const connection = new Connection(
  "YOUR_RPC"
);
const userPublicKey = userKeypair.publicKey;
const poolPublicKey = new PublicKey(
  "HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR"
);

//Pools
//5BKxfWMbmYBAEWvyPZS9esPducUba9GqyMjtLCfbaqyF
//HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR
//GMgh4NtWrGaUf1RR2kcXD7LY1jou1qFAuSsQeKp5ow4a

const TOTAL_RANGE_INTERVAL = 15;
const TOKEN_MINTS = [
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
];

let isCheckingPositions = false; // Flag to track ongoing checks

interface Balance {
  mint: string;
  owner: string;
  amount: string;
  delegateOption: number;
  delegate: string;
  state: number;
  isNativeOption: number;
  isNative: string;
  delegatedAmount: string;
  closeAuthorityOption: number;
  closeAuthority: string;
}

async function fetchBalances(): Promise<Balance[]> {
  return new Promise((resolve) => {
    setTimeout(async () => {
      try {
        const response = await axios.post(
          "https://rest-api.hellomoon.io/v0/token/balances-by-owner",
          {
            ownerAccount: userPublicKey.toString(),
          },
          {
            headers: {
              accept: "application/json",
              authorization: "Bearer 6c3d7c81-5f42-45da-a5c0-73fade41553d",
              "content-type": "application/json",
            },
          }
        );

        const balances = response.data as Balance[];
        const filteredBalances = balances.filter((balance) =>
          TOKEN_MINTS.includes(balance.mint)
        );
        resolve(filteredBalances);
      } catch (error) {
        console.error("Error fetching balances:", error);
        resolve([]); // Return an empty array in case of error
      }
    }, 10000); // 10 second delay
  });
}

(async () => {
  async function managePositions() {
    if (isCheckingPositions) {
      console.log("Previous check still running. Skipping this iteration.");
      return;
    }

    isCheckingPositions = true;

    try {
      const dlmmPool = await DLMM.create(connection, poolPublicKey);

      // Get active bin
      const activeBin = await dlmmPool.getActiveBin();
      const minBinId = activeBin.binId - TOTAL_RANGE_INTERVAL;
      const maxBinId = activeBin.binId + TOTAL_RANGE_INTERVAL;

      // Get user positions
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(
        userPublicKey
      );

      if (userPositions.length === 0) {
        console.log(
          "No open positions found for the wallet. Creating a new position."
        );

        const balances = await fetchBalances();
        const tokenBalances = balances.filter((balance) =>
          TOKEN_MINTS.includes(balance.mint)
        );

        if (tokenBalances.length !== 2) {
          console.error("Required token balances not found.");
          isCheckingPositions = false;
          return;
        }

        const totalXAmount = new BN(tokenBalances[0].amount);
        const totalYAmount = new BN(tokenBalances[1].amount);

        const newBalancePosition = Keypair.generate(); // New keypair for the new position

        const createPositionTx =
          await dlmmPool.initializePositionAndAddLiquidityByStrategy({
            positionPubKey: newBalancePosition.publicKey,
            user: userPublicKey,
            totalXAmount,
            totalYAmount,
            strategy: {
              maxBinId,
              minBinId,
              strategyType: StrategyType.SpotBalanced,
            },
          });

        const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 175000, // Adjust this as needed
        });

        const transaction = new Transaction()
          .add(addPriorityFee)
          .add(createPositionTx);

        try {
          const createBalancePositionTxHash = await sendAndConfirmTransaction(
            connection,
            transaction,
            [userKeypair, newBalancePosition]
          );
          console.log(
            `Created a new position in bin ${activeBin.binId}. Transaction hash: ${createBalancePositionTxHash}`
          );
        } catch (error) {
          console.error("Error creating new position:", error);
        }
        isCheckingPositions = false;
        return;
      }

      // Check positions and close if out of range
      for (const position of userPositions) {
        const binData = position.positionData.positionBinData;

        // Ensure there are at least two bins to check
        if (binData.length < 2) {
          console.log(
            `Position ${position.publicKey.toString()} does not have enough bin data.`
          );
          continue;
        }

        const secondToLastBinId = binData[binData.length - 2]?.binId;
        const isInRange =
          secondToLastBinId >= minBinId && secondToLastBinId <= maxBinId;

        if (!isInRange) {
          console.log(
            `Position ${position.publicKey.toString()} is out of range. Closing it.`
          );
          const binIdsToRemove = binData.map((bin) => bin.binId);
          const removeLiquidityTx = await dlmmPool.removeLiquidity({
            position: position.publicKey,
            user: userPublicKey,
            binIds: binIdsToRemove,
            bps: new BN(10000), // 100% (range from 0 to 100)
            shouldClaimAndClose: true, // should claim swap fee and close position together
          });

          try {
            for (let tx of Array.isArray(removeLiquidityTx)
              ? removeLiquidityTx
              : [removeLiquidityTx]) {
              const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: 175000, // Adjust this as needed
              });

              const transaction = new Transaction().add(addPriorityFee).add(tx);

              const removeBalanceLiquidityTxHash =
                await sendAndConfirmTransaction(connection, transaction, [
                  userKeypair,
                ]);
              console.log(
                `Closed position ${position.publicKey.toString()}. Transaction hash: ${removeBalanceLiquidityTxHash}`
              );
            }
          } catch (error) {
            console.error("Error closing position", error);
            isCheckingPositions = false;
            return; // Ensure no new position is created if the close transaction fails
          }
        } else {
          console.log(`Position ${position.publicKey.toString()} is in range.`);
        }
      }
    } catch (error) {
      console.error("Error managing positions");
    } finally {
      isCheckingPositions = false; // Reset the flag once the check is complete
    }
  }

  // Check positions every minute
  setInterval(managePositions, 60000);
  await managePositions(); // Initial call
})();
