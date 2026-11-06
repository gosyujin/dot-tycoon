import { defineConfig, type Plugin } from 'vite';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// 開発時だけ ./dev-samples を /dev-samples/ で配信する（本番ビルドには含めない）
function devSamples(): Plugin {
  return {
    name: 'dev-samples',
    apply: 'serve',
    configureServer(server) {
      const root = resolve(__dirname, 'dev-samples');
      server.middlewares.use('/dev-samples', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]);
        const file = resolve(root, '.' + rel);
        // dev-samples の外へは出さない
        if (file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile()) {
          const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.json') ? 'application/json' : 'image/jpeg';
          res.setHeader('Content-Type', type);
          createReadStream(file).pipe(res);
        } else {
          next();
        }
      });
    },
  };
}

export default defineConfig({
  // 相対ベース: GitHub Pages のどのリポジトリ名でも、localhost でもそのまま動く
  base: './',
  plugins: [devSamples()],
  build: { target: 'es2022' },
});
