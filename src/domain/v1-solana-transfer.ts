import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  type TransactionBlockhashCtor,
} from "@solana/web3.js";

export const v1SolanaUsdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const v1SolanaTokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const v1SolanaAssociatedProgram = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export async function v1SolanaTransfer(input: {
  source: string;
  recipient: string;
  amount: string;
  blockhash: string;
  lastValidBlockHeight: string;
}) {
  if (
    !/^[1-9][0-9]{0,19}$/.test(input.amount) ||
    BigInt(input.amount) > 101_000_000n ||
    !/^(0|[1-9][0-9]{0,19})$/.test(input.lastValidBlockHeight) ||
    BigInt(input.lastValidBlockHeight) >= 1n << 64n
  )
    throw new Error("Invalid fixed Solana transfer amount/height");
  const source = new PublicKey(input.source),
    recipient = new PublicKey(input.recipient),
    mint = new PublicKey(v1SolanaUsdc),
    token = new PublicKey(v1SolanaTokenProgram),
    associated = new PublicKey(v1SolanaAssociatedProgram);
  if (new PublicKey(input.blockhash).toBase58() !== input.blockhash)
    throw new Error("Invalid canonical Solana blockhash");
  if (
    !PublicKey.isOnCurve(source.toBytes()) ||
    source.equals(recipient) ||
    recipient.equals(PublicKey.default)
  )
    throw new Error("Invalid Solana source/deposit address");
  const [from] = await PublicKey.findProgramAddress(
      [source.toBytes(), token.toBytes(), mint.toBytes()],
      associated,
    ),
    [to] = await PublicKey.findProgramAddress(
      [recipient.toBytes(), token.toBytes(), mint.toBytes()],
      associated,
    );
  const create = new TransactionInstruction({
    programId: associated,
    keys: [
      { pubkey: source, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: PublicKey.default, isSigner: false, isWritable: false },
      { pubkey: token, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([1]),
  });
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, BigInt(input.amount), true);
  data[9] = 6;
  const transfer = new TransactionInstruction({
    programId: token,
    keys: [
      { pubkey: from, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: to, isSigner: false, isWritable: true },
      { pubkey: source, isSigner: true, isWritable: false },
    ],
    data,
  });
  const transaction = new Transaction({
    feePayer: source,
    blockhash: input.blockhash as TransactionBlockhashCtor["blockhash"],
    lastValidBlockHeight: BigInt(input.lastValidBlockHeight),
  }).add(create, transfer);
  return {
    transaction,
    sourceTokenAccount: from.toBase58(),
    destinationTokenAccount: to.toBase58(),
  };
}
