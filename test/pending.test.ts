import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { emptyBoardScene } from '../src/main/boards.ts'
import { PendingStore } from '../src/main/pending.ts'
import { RequestHub, type DrawRequest, type Handoff, type Submission } from '../src/main/requests.ts'

function makeEnv(ioOverrides: ConstructorParameters<typeof PendingStore>[0]['io'] = {}) {
  const home = mkdtempSync(join(tmpdir(), 'flyingdraws-pending-'))
  const boardsDir = join(home, 'boards')
  const pendingPath = join(home, 'pending.json')
  mkdirSync(boardsDir, { recursive: true })

  let currentBoardId = 'default'
  const sessions = new Map<string, { hub: RequestHub }>()
  const requestBoard = new Map<string, string>()

  const getHub = (boardId: string): RequestHub => {
    let s = sessions.get(boardId)
    if (!s) {
      const hub = new RequestHub()
      hub.onChange(() => store.persist())
      s = { hub }
      sessions.set(boardId, s)
    }
    return s.hub
  }

  const store = new PendingStore({
    pendingPath,
    boardsDir,
    getCurrentBoardId: () => currentBoardId,
    sessions,
    getHub,
    onRequestRestored: (reqId, boardId) => requestBoard.set(reqId, boardId),
    io: ioOverrides
  })

  return {
    home,
    boardsDir,
    pendingPath,
    sessions,
    requestBoard,
    getHub,
    store,
    setCurrentBoardId: (id: string) => {
      currentBoardId = id
    },
    cleanup: () => rmSync(home, { recursive: true, force: true })
  }
}

function sampleDrawReq(id: string, prompt = '请画图'): DrawRequest {
  return {
    id,
    kind: 'draw',
    proposalId: null,
    baseline: null,
    prompt,
    createdAt: '2026-11-16T10:00:00.000Z',
    status: 'waiting',
    submission: null
  }
}

function sampleProposalReq(id: string, proposalId: string): DrawRequest {
  return {
    id,
    kind: 'proposal',
    proposalId,
    baseline: null,
    prompt: '请确认修改',
    createdAt: '2026-11-16T10:00:00.000Z',
    status: 'waiting',
    submission: null
  }
}

function sampleSubmission(note: string): Submission {
  return {
    requestId: null,
    note,
    sceneJson: '{"elements":[]}',
    pngBase64: null,
    version: 2,
    at: '2026-11-16T10:01:00.000Z'
  }
}

function sampleHandoff(from: string, to: string | null): Handoff {
  return {
    from,
    to,
    note: '交给你了',
    sceneJson: '{"elements":[]}',
    pngBase64: null,
    version: 3,
    at: '2026-11-16T10:02:00.000Z'
  }
}

test('restore() 期间不触发中途覆盖写盘，且后续 persist() 保留未访问画板的待处理项', () => {
  let writeCount = 0
  let renameCount = 0
  const env = makeEnv({
    writeFileSync: (...args) => {
      writeCount += 1
      return writeFileSync(...args)
    },
    renameSync: (...args) => {
      renameCount += 1
      return renameSync(...args)
    }
  })

  try {
    writeFileSync(join(env.boardsDir, 'board-a.excalidraw'), JSON.stringify(emptyBoardScene()), 'utf8')
    writeFileSync(join(env.boardsDir, 'board-b.excalidraw'), JSON.stringify(emptyBoardScene()), 'utf8')
    const initial = {
      version: 2,
      boards: {
        'board-a': [sampleDrawReq('req_a1', '画板 A 请求')],
        'board-b': [sampleDrawReq('req_b1', '画板 B 请求')]
      },
      inbox: {
        'board-b': [sampleSubmission('B 的收件箱')]
      },
      handoffs: {
        'board-b': [sampleHandoff('前端', '后端')]
      }
    }
    writeFileSync(env.pendingPath, JSON.stringify(initial), 'utf8')

    env.store.restore()

    // restore() 过程不得因 hub.restore() 触发的 emit() 而中途写盘
    assert.equal(writeCount, 0)
    assert.equal(renameCount, 0)
    assert.equal(env.sessions.has('board-a'), true)
    assert.equal(env.sessions.has('board-b'), true)
    assert.equal(env.requestBoard.get('req_a1'), 'board-a')
    assert.equal(env.requestBoard.get('req_b1'), 'board-b')

    // 只操作 board-a（从未访问 board-b），board-b 的数据仍完整保留
    const reqA2 = env.getHub('board-a').create('画板 A 新请求')
    assert.equal(writeCount, 1)
    assert.equal(renameCount, 1)

    const saved = JSON.parse(readFileSync(env.pendingPath, 'utf8')) as {
      boards: Record<string, DrawRequest[]>
      inbox?: Record<string, Submission[]>
      handoffs?: Record<string, Handoff[]>
    }
    assert.deepEqual(saved.boards['board-a'].map((r) => r.id), ['req_a1', reqA2.id])
    assert.deepEqual(saved.boards['board-b'].map((r) => r.id), ['req_b1'])
    assert.equal(saved.inbox?.['board-b']?.[0]?.note, 'B 的收件箱')
    assert.equal(saved.handoffs?.['board-b']?.[0]?.to, '后端')
  } finally {
    env.cleanup()
  }
})

test('persist() 写盘失败时不更新 lastPendingKey，相同状态重试时能重新落盘', () => {
  let failRename = true
  const env = makeEnv({
    renameSync: (from, to) => {
      if (failRename) throw new Error('simulated EACCES')
      return renameSync(from, to)
    }
  })

  try {
    const req = env.getHub('default').create('测试重试')
    assert.equal(existsSync(env.pendingPath), false)

    // 恢复写盘能力后以相同状态再次 persist()，必须成功落盘
    failRename = false
    env.store.persist()

    assert.equal(existsSync(env.pendingPath), true)
    const saved = JSON.parse(readFileSync(env.pendingPath, 'utf8')) as { boards: Record<string, DrawRequest[]> }
    assert.deepEqual(saved.boards['default'].map((r) => r.id), [req.id])
  } finally {
    env.cleanup()
  }
})

test('restore() 遇到损坏或缺少 elements 的画板文件时保留 proposal 请求，正常画板上已删提议仍被清理', () => {
  const env = makeEnv()
  try {
    writeFileSync(join(env.boardsDir, 'corrupt.excalidraw'), '{not valid json', 'utf8')
    writeFileSync(join(env.boardsDir, 'malformed.excalidraw'), JSON.stringify({ version: 2 }), 'utf8')
    writeFileSync(join(env.boardsDir, 'clean.excalidraw'), JSON.stringify(emptyBoardScene()), 'utf8')

    writeFileSync(
      env.pendingPath,
      JSON.stringify({
        version: 2,
        boards: {
          corrupt: [sampleProposalReq('req_corrupt', 'prop_1')],
          malformed: [sampleProposalReq('req_malformed', 'prop_2')],
          clean: [sampleProposalReq('req_stale', 'prop_deleted')]
        }
      }),
      'utf8'
    )

    env.store.restore()

    assert.deepEqual(env.getHub('corrupt').waiting().map((r) => r.id), ['req_corrupt'])
    assert.deepEqual(env.getHub('malformed').waiting().map((r) => r.id), ['req_malformed'])
    assert.equal(env.sessions.has('clean'), false)
  } finally {
    env.cleanup()
  }
})

test('restore() 跳过不存在的非当前画板文件，并支持旧版 v1 requests 格式迁移', () => {
  const env = makeEnv()
  try {
    env.setCurrentBoardId('active-unsaved')
    writeFileSync(
      env.pendingPath,
      JSON.stringify({
        board: 'active-unsaved',
        requests: [sampleDrawReq('req_v1', '旧格式请求')]
      }),
      'utf8'
    )

    env.store.restore()
    assert.deepEqual(env.getHub('active-unsaved').waiting().map((r) => r.id), ['req_v1'])

    // 切换当前画板为 default 后再恢复一个不存在的 ghost 画板，ghost 应被跳过
    const env2 = makeEnv()
    try {
      writeFileSync(
        env2.pendingPath,
        JSON.stringify({
          version: 2,
          boards: {
            ghost: [sampleDrawReq('req_ghost')]
          }
        }),
        'utf8'
      )
      env2.store.restore()
      assert.equal(env2.sessions.has('ghost'), false)
    } finally {
      env2.cleanup()
    }
  } finally {
    env.cleanup()
  }
})
