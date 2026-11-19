import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkdown } from '../src/shared/markdown.ts'

const para = (...children: unknown[]) => ({ kind: 'paragraph', children })
const sample = [
  '| 动作 | 对象 | 结果 |', '|---|---|---|',
  '| `canvas_read` | board=`协作测试`, as=`Fuxi` | **v28**，7 节点 / 6 连线 / 6 文字 / 39 笔手绘 |',
  '| `canvas_read`（本次复核） | 同上 | 仍 **v28**，元素构成与首次读一致 |',
  '', '两次读版本号一致（v28→v28），说明这一轮间隔内没有别的席位改动画板。', '', '## 工作区核对'
]

test('真实回复中的表格、行内代码、强调、段落和二级标题', () => {
  const [table, summary, heading] = parseMarkdown(sample.join('\r\n'))
  assert.equal(table.kind, 'table')
  assert.deepEqual(table.header, [['动作'], ['对象'], ['结果']])
  assert.equal(table.rows.length, 2)
  assert.deepEqual(table.rows[0][1], ['board=', { kind: 'code', text: '协作测试' }, ', as=', { kind: 'code', text: 'Fuxi' }])
  assert.deepEqual(table.rows[0][2][0], { kind: 'strong', children: ['v28'] })
  assert.deepEqual(summary, para(sample[5]))
  assert.deepEqual(heading, { kind: 'heading', level: 2, children: ['工作区核对'] })
})

test('标题六级、段落内换行、斜体、引用和分割线', () => {
  for (let i = 1; i <= 6; i++) assert.deepEqual(parseMarkdown('#'.repeat(i) + ' 标题'), [{ kind: 'heading', level: i, children: ['标题'] }])
  assert.deepEqual(parseMarkdown('正文\n换行\n\n> *引用*\n> 第二行\n---'), [
    para('正文\n换行'), { kind: 'quote', blocks: [para({ kind: 'em', children: ['引用'] }, '\n第二行')] }, { kind: 'rule' }
  ])
})

test('有序、无序列表支持不同起点、缩进和两层混排', () => {
  assert.deepEqual(parseMarkdown('3. 父项\n   - 子项\n   - 子项二\n4. 下一项'), [{
    kind: 'list', ordered: true, start: 3, items: [
      [para('父项'), { kind: 'list', ordered: false, start: 1, items: [[para('子项')], [para('子项二')]] }], [para('下一项')]
    ]
  }])
})

test('代码块保留空行、缩进、Markdown 符号，流式代码围栏可稍后闭合', () => {
  const content = '  if (x) {\n\n    **原样**\n  }'
  for (const ending of ['', '\n```']) {
    assert.deepEqual(parseMarkdown('```js\n' + content + ending), [{ kind: 'code', text: content }])
  }
})

test('表格对齐、代码中的竖线、转义竖线和流式缺列', () => {
  const [table] = parseMarkdown('一 | 二 | 三\n:---|:---:|---:\n`a|b` | x\\|y | **粗**\n|半行')
  assert.equal(table.kind, 'table')
  assert.deepEqual(table.align, ['left', 'center', 'right'])
  assert.deepEqual(table.rows[0][0], [{ kind: 'code', text: 'a|b' }])
  assert.deepEqual(table.rows[0][1], ['x|y'])
  assert.deepEqual(table.rows[1], [['半行'], [], []])
  for (const line of ['|一|二|', '|一|二|\n|---|']) assert.equal(parseMarkdown(line)[0].kind, 'paragraph')
})

test('HTML 始终是文本，只有绝对 HTTP(S) 链接能生成链接节点', () => {
  for (const value of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '[x](javascript:alert(1))', '[x](data:text/html,test)', '[x](file:///tmp/test)', '[x](//example.org)', '[x](https://)']) {
    assert.deepEqual(parseMarkdown(value), [para(value)])
  }
  for (const url of ['http://example.org/', 'https://example.org/a(b)']) {
    assert.deepEqual(parseMarkdown('[**说明**](' + url + ')'), [para({ kind: 'link', href: url, children: [{ kind: 'strong', children: ['说明'] }] })])
  }
})
