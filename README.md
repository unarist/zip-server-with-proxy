# ZIP Archive Server w/ Remote Fetch Proxy

```mermaid
sequenceDiagram
  participant S as Server
  participant B1 as Client@origin1
  participant B2 as Client@origin2

  B2 ->> S: (Connect WebSocket)
  B1 ->> S: Create archive
  B1 ->> S: Add file from bytes
  B1 ->> S: Add file from URL@origin2
  S ->> B2: ws: Please fetch URL@origin2
  B2 ->> S: Add file from bytes<br>(streaming from URL)
  B2 ->> S: ws: done
  B1 ->> S: Complete archive
```

- WebSocketを経由して別オリジンの別タブで動いているスクリプトに指示を出す
  - 微妙に無駄を省こうと特化実装にしてしまったが、純粋なRPCプロキシにしたら汎用できそう
- Fetch Upload Streaming
  - GETしたものをPUTに横流しする
  - 最終的にzip.jsに渡すところまでストリーミング（のはず）
- フロント用のJSをサーバーのソースコード中にTypeScriptで書く（？）
  - 関数をtoStringしたらJSの文字列が取れる
  - TypeScriptで書けるしサーバー向けに定義した型が流用できる
