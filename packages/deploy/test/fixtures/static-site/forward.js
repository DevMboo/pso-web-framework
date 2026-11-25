// Loopback forwarder: 127.0.0.1:3999 -> the orchestrator container of a Compose network (plain TCP, so HTTP and WebSocket both pass).
const net = require("node:net");
const target = process.argv[2] ?? "gateway:3000"; const [host, port] = target.split(":");
net.createServer((c) => { const u = net.connect(Number(port), host); c.pipe(u); u.pipe(c); c.on("error", () => u.destroy()); u.on("error", () => c.destroy()); }).listen(3999, "127.0.0.1", () => console.log(`forwarding 127.0.0.1:3999 -> ${target}`));
