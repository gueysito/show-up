import { readFile } from "node:fs/promises";
import { createLocalCertificate } from "./local-certificate";
import { createServer } from "node:https";
import { request as upstream } from "node:http";

const port = Number(process.argv[2] ?? 3443);
const target = Number(process.argv[3] ?? 3100);
if (![port, target].every((value) => Number.isInteger(value) && value >= 1024 && value <= 65535))
  throw new Error("Choose two unprivileged local ports");
const { certificate, privateKey, dispose } = await createLocalCertificate();
const server = createServer(
  { key: await readFile(privateKey), cert: await readFile(certificate) },
  (incoming, outgoing) => {
    if (incoming.headers.host !== `localhost:${port}`) {
      outgoing.writeHead(421).end();
      return;
    }
    const headers = { ...incoming.headers };
    for (const name of Object.keys(headers))
      if (name.startsWith("x-forwarded-") || name === "forwarded") delete headers[name];
    const proxied = upstream(
      { hostname: "127.0.0.1", port: target, path: incoming.url, method: incoming.method, headers },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    proxied.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end("Local Showup server is unavailable.");
    });
    incoming.on("aborted", () => proxied.destroy());
    incoming.pipe(proxied);
  },
);
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(port, "127.0.0.1", () => console.log(`Local HTTPS: https://localhost:${port}`));
async function shutdown() {
  server.closeAllConnections();
  server.close();
  await dispose();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
