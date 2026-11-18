import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isAppRendererUrl } from '../src/main/rendererUrl.ts'

const file = join(process.cwd(), 'out', 'renderer', 'index.html')
const page = pathToFileURL(file).href

test('渲染页地址：只认打包里的 index.html', () => {
  assert.equal(isAppRendererUrl(page, file), true)
  assert.equal(isAppRendererUrl(`${page}#board=a`, file), true, '带 hash 也是同一页')
  assert.equal(isAppRendererUrl(`${page}?x=1`, file), true)
  assert.equal(isAppRendererUrl(pathToFileURL(join(process.cwd(), 'evil.html')).href, file), false, '别的本地文件不算')
  assert.equal(isAppRendererUrl('https://excalidraw.com/', file), false)
  assert.equal(isAppRendererUrl('about:blank', file), false)
  assert.equal(isAppRendererUrl('', file), false)
  assert.equal(isAppRendererUrl(undefined, file), false)
  assert.equal(isAppRendererUrl('not a url', file), false)
})

test('渲染页地址：开发模式只认 dev server 同源', () => {
  const dev = 'http://localhost:5173/'
  assert.equal(isAppRendererUrl('http://localhost:5173/index.html', file, dev), true)
  assert.equal(isAppRendererUrl('http://localhost:5174/', file, dev), false, '端口不同不算')
  assert.equal(isAppRendererUrl('https://evil.example/', file, dev), false)
  assert.equal(isAppRendererUrl(page, file, dev), true, '开发模式下打包页面仍可用')
  assert.equal(isAppRendererUrl('http://localhost:5173/', file, 'file:///x'), false, '非 http 的 dev 地址不采纳')
})
