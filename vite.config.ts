import { defineConfig } from 'vite'
import userscript from 'vite-userscript-plugin'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  base: './',
  build: {
    minify: true,
    sourcemap: true,
  },
  plugins: [
    userscript({
      entry: 'src/index.ts',
      fileName: 'yandex-pogoda',
      autoMetaUrls: true,
      header: {
        name: 'Яндекс Погода: Идёт дождь?',
        version: pkg.version,
        description: pkg.description,
        icon: 'greasify.svg',
        homepage: 'https://greasify.github.io/yandex-pogoda-userscript/',
        match: 'https://yandex.ru/pogoda/*/maps/nowcast*',
        grant: 'none',
      },
      server: {
        file: true,
      },
    }),
  ],
})
