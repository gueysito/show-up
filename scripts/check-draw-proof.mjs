import { readFile } from "node:fs/promises";
import { verifyDrawProof } from "../src/server/protocol/draw-proof.ts";

const bytes = await readFile("contracts/.cache/draw-proof-public.json");
if (bytes.length > 32768) throw new Error("Oversized public proof fixture");
const input = JSON.parse(bytes.toString("utf8"));
if (input.context?.domain !== "showup.sandbox.authorization.v1" || !verifyDrawProof(input))
  throw new Error("Independent sandbox proof replay failed");
console.log(
  "PASS: native Node independently verifies the actual sandbox-accepted first-round proof",
);
