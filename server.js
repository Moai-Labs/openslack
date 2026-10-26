// Placeholder page until the product replaces it. Node's standard library only.
const http = require("node:http");

const port = Number(process.env.PORT) || 3000;
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coming soon</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font-family: system-ui, sans-serif; background: #fafafa; color: #222; }
  main { max-width: 32rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.75rem; margin: 0 0 0.75rem; }
  p { line-height: 1.5; color: #555; }
</style>
</head>
<body>
<main>
  <h1>Coming soon</h1>
  <p>This product is being built in the open. The first version will appear here.</p>
</main>
</body>
</html>
`;

http.createServer((req, res) => {
    if (req.url === "/healthz") {
        res.writeHead(200, {"content-type": "text/plain"});
        return res.end("ok\n");
    }
    res.writeHead(200, {"content-type": "text/html; charset=utf-8"});
    res.end(page);
}).listen(port, () => console.log(`listening on ${port}`));
