import React, { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  MessageCircle,
  Radio,
  RefreshCw,
  Send,
  Shield,
} from 'lucide-react'

const STATUS = /** @type {const} */ ({
  Safe: 'Safe',
  Help: 'Help',
  Resource: 'Resource',
})

function formatTime(tsSeconds) {
  if (!tsSeconds) return ''
  const d = new Date(tsSeconds * 1000)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function relativeTime(tsSeconds) {
  if (!tsSeconds) return ''
  const ms = Date.now() - tsSeconds * 1000
  if (!Number.isFinite(ms) || ms < 0) return formatTime(tsSeconds)
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function statusMeta(status) {
  switch (status) {
    case STATUS.Safe:
      return {
        label: 'SAFE',
        icon: Shield,
        badge: 'border-emerald-900/60 bg-emerald-950/40 text-emerald-300',
        accent: 'text-emerald-300',
      }
    case STATUS.Help:
      return {
        label: 'HELP',
        icon: AlertTriangle,
        badge: 'border-amber-900/60 bg-amber-950/30 text-amber-300',
        accent: 'text-amber-300',
      }
    case STATUS.Resource:
      return {
        label: 'RESOURCE',
        icon: Radio,
        badge: 'border-cyan-900/60 bg-cyan-950/30 text-cyan-300',
        accent: 'text-cyan-300',
      }
    default:
      return {
        label: String(status || 'UNKNOWN').toUpperCase(),
        icon: Radio,
        badge: 'border-slate-800 bg-slate-950/30 text-slate-200',
        accent: 'text-slate-200',
      }
  }
}

function cn(...xs) {
  return xs.filter(Boolean).join(' ')
}

function TabButton({ active, onClick, icon: Icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm',
        'border transition',
        active
          ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-200'
          : 'border-slate-800 bg-slate-950/30 text-slate-200 hover:border-slate-700',
      )}
    >
      <Icon className={cn('h-4 w-4', active ? 'text-emerald-300' : 'text-slate-300')} />
      <span className="font-medium">{label}</span>
    </button>
  )
}

export default function App() {
  const [alias, setAlias] = useState(() => localStorage.getItem('pilink.alias') || '')
  const [status, setStatus] = useState(STATUS.Safe)
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [tab, setTab] = useState('board')

  const [chatQ, setChatQ] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [chatErr, setChatErr] = useState('')
  const [chat, setChat] = useState(() => {
    try {
      const raw = localStorage.getItem('pilink.chat.cache')
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  })

  const [posts, setPosts] = useState(() => {
    try {
      const raw = localStorage.getItem('pilink.posts.cache')
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  })
  const [loading, setLoading] = useState(posts.length === 0)
  const [error, setError] = useState('')
  const [lastSync, setLastSync] = useState(0)

  const listRef = useRef(null)
  const chatRef = useRef(null)

  useEffect(() => {
    localStorage.setItem('pilink.alias', alias)
  }, [alias])

  useEffect(() => {
    try {
      localStorage.setItem('pilink.chat.cache', JSON.stringify(chat.slice(-24)))
    } catch {
      // ignore cache write failures
    }
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight
  }, [chat])

  async function refreshPosts({ silent } = { silent: false }) {
    let aborted = false
    const ac = new AbortController()
    const t = setTimeout(() => {
      aborted = true
      ac.abort()
    }, 4500)

    try {
      if (!silent) setLoading(true)
      setError('')

      const res = await fetch('/api/posts', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: ac.signal,
      })
      if (!res.ok) throw new Error(`GET /api/posts -> ${res.status}`)
      const data = await res.json()
      if (!Array.isArray(data)) throw new Error('Invalid posts payload')

      setPosts(data)
      setLastSync(Date.now())
      try {
        localStorage.setItem('pilink.posts.cache', JSON.stringify(data))
      } catch {
        // ignore cache write failures
      }
    } catch (e) {
      if (aborted) setError('Network timeout (node busy or out of range)')
      else setError(e?.message || 'Failed to load feed')
    } finally {
      clearTimeout(t)
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    refreshPosts({ silent: false })

    // Light polling for "live" feel without hammering a Pi.
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refreshPosts({ silent: true })
    }, 5000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submit(e) {
    e.preventDefault()
    if (!alias.trim() || !content.trim()) return

    setSubmitting(true)
    setError('')
    try {
      const res = await fetch('/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          alias: alias.trim().slice(0, 32),
          status,
          content: content.trim().slice(0, 600),
        }),
      })
      if (!res.ok) throw new Error(`POST /api/posts -> ${res.status}`)
      const created = await res.json()

      // Prepend locally for snappy UX; next poll will reconcile.
      setPosts((p) => [created, ...p])
      setContent('')

      // Nudge scroll to top so the new broadcast is visible.
      if (listRef.current) listRef.current.scrollTop = 0
    } catch (e) {
      setError(e?.message || 'Failed to broadcast')
    } finally {
      setSubmitting(false)
    }
  }

  async function askAi(e) {
    e.preventDefault()
    const q = chatQ.trim()
    if (!q || chatBusy) return

    setChatBusy(true)
    setChatErr('')
    setChatQ('')
    setChat((c) => [...c, { role: 'user', text: q, t: Date.now() }])

    let aborted = false
    const ac = new AbortController()
    const t = setTimeout(() => {
      aborted = true
      ac.abort()
    }, 15000)

    try {
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ question: q }),
        signal: ac.signal,
      })
      if (!res.ok) {
        const maybe = await res.json().catch(() => null)
        const msg = maybe?.error ? String(maybe.error) : `POST /api/ai -> ${res.status}`
        throw new Error(msg)
      }
      const data = await res.json()
      const a = String(data?.answer || '').trim()
      setChat((c) => [...c, { role: 'ai', text: a || '(no response)', t: Date.now() }])
    } catch (e) {
      setChatErr(aborted ? 'AI timeout (node busy or model cold-starting)' : e?.message || 'AI request failed')
      setChat((c) => [...c, { role: 'ai', text: 'AI link degraded. Try again or ask a shorter question.', t: Date.now() }])
    } finally {
      clearTimeout(t)
      setChatBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-emerald-400">
      {/* Background: subtle grid + radial glow */}
      <div className="pointer-events-none fixed inset-0 opacity-60">
        <div className="absolute inset-0 bg-[radial-gradient(900px_circle_at_20%_10%,rgba(16,185,129,0.14),transparent_60%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(30,41,59,0.38)_1px,transparent_1px),linear-gradient(to_bottom,rgba(30,41,59,0.38)_1px,transparent_1px)] bg-[size:48px_48px]" />
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950/30 via-slate-950/60 to-slate-950" />
      </div>

      <div className="relative mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <header className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl border border-slate-800 bg-slate-950/40">
              <Radio className="h-5 w-5 text-emerald-300" />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight text-slate-100">PILink Emergency Hub</div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-400">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/50" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
                </span>
                <span>System live</span>
                <span className="text-slate-600">•</span>
                <span className="text-slate-500">Last sync</span>
                <span className="text-emerald-300">{lastSync ? new Date(lastSync).toLocaleTimeString() : '—'}</span>
              </div>
            </div>
          </div>
        </header>

        <div className="mt-4 flex gap-2 lg:hidden">
          <TabButton active={tab === 'board'} onClick={() => setTab('board')} icon={Radio} label="Board" />
          <TabButton active={tab === 'broadcast'} onClick={() => setTab('broadcast')} icon={Send} label="Broadcast" />
          <TabButton active={tab === 'ai'} onClick={() => setTab('ai')} icon={MessageCircle} label="AI" />
        </div>

        <main className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <section className={cn('lg:col-span-5', tab !== 'ai' ? 'hidden lg:block' : '')}>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/40 backdrop-blur">
              <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
                <div className="flex items-center gap-2">
                  <MessageCircle className="h-4 w-4 text-emerald-300" />
                  <div className="text-sm font-semibold text-slate-100">PILink AI</div>
                </div>
                <div className="text-xs text-slate-400">Survival expert mode</div>
              </div>

              <div className="px-4 py-4">
                <div
                  ref={chatRef}
                  className="max-h-[36vh] overflow-auto rounded-2xl border border-slate-800 bg-slate-950/30 p-3"
                >
                  {chat.length === 0 ? (
                    <div className="text-xs text-slate-500">
                      Ask about water purification, first aid, shelter, navigation, signaling, or triage.
                    </div>
                  ) : (
                    <div className="grid gap-2">
                      {chat.slice(-24).map((m, idx) => (
                        <div
                          key={`${m.t || 0}-${idx}`}
                          className={cn(
                            'rounded-xl border px-3 py-2 text-sm leading-relaxed',
                            m.role === 'user'
                              ? 'ml-6 border-slate-800 bg-slate-950/35 text-slate-100'
                              : 'mr-6 border-emerald-900/50 bg-emerald-950/25 text-emerald-100',
                          )}
                        >
                          <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.18em] text-slate-500">
                            {m.role === 'user' ? 'You' : 'Survival Expert'}
                          </div>
                          <div className="whitespace-pre-wrap break-words">{m.text}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {chatErr ? (
                  <div className="mt-3 rounded-xl border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
                    {chatErr}
                  </div>
                ) : null}

                <form onSubmit={askAi} className="mt-3 flex items-center gap-2">
                  <input
                    value={chatQ}
                    onChange={(e) => setChatQ(e.target.value)}
                    placeholder="Ask a survival question…"
                    className="w-full rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-slate-100 placeholder:text-slate-600 outline-none focus:border-emerald-700 focus:ring-2 focus:ring-emerald-700/30"
                    maxLength={320}
                  />
                  <button
                    type="submit"
                    disabled={chatBusy || !chatQ.trim()}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-mono uppercase tracking-[0.22em] transition',
                      'border border-emerald-900/60 bg-emerald-950/40 text-emerald-200',
                      'hover:border-emerald-800 hover:bg-emerald-950/55',
                      'disabled:cursor-not-allowed disabled:opacity-50',
                    )}
                    aria-label="Send question"
                    title="Send"
                  >
                    <Send className="h-4 w-4" />
                    <span className="hidden sm:inline">Ask</span>
                  </button>
                </form>
              </div>
            </div>

            <div className={cn('mt-4 rounded-2xl border border-slate-800 bg-slate-950/40 backdrop-blur', tab !== 'broadcast' ? 'hidden lg:block' : '')}>
              <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
                <div className="text-sm font-semibold text-slate-100">Broadcast</div>
                <div className="text-xs text-slate-400">Share status + location</div>
              </div>

              <form onSubmit={submit} className="px-4 py-4">
                <div className="grid grid-cols-1 gap-3">
                  <label className="block">
                    <div className="mb-1 text-xs text-slate-400">Alias</div>
                    <input
                      value={alias}
                      onChange={(e) => setAlias(e.target.value)}
                      placeholder="Name or callsign"
                      className="w-full rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-slate-100 placeholder:text-slate-600 outline-none ring-0 focus:border-emerald-700 focus:ring-2 focus:ring-emerald-700/30"
                      autoComplete="nickname"
                      maxLength={32}
                    />
                  </label>

                  <label className="block">
                    <div className="mb-1 text-xs text-slate-400">Status</div>
                    <select
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                      className="w-full rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-slate-100 outline-none focus:border-emerald-700 focus:ring-2 focus:ring-emerald-700/30"
                    >
                      <option value={STATUS.Safe}>Safe</option>
                      <option value={STATUS.Help}>Help</option>
                      <option value={STATUS.Resource}>Resource</option>
                    </select>
                  </label>

                  <label className="block">
                    <div className="mb-1 text-xs text-slate-400">Message</div>
                    <textarea
                      value={content}
                      onChange={(e) => setContent(e.target.value)}
                      placeholder="Location, needs, resources, updates..."
                      rows={5}
                      className="w-full resize-none rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-slate-100 placeholder:text-slate-600 outline-none ring-0 focus:border-emerald-700 focus:ring-2 focus:ring-emerald-700/30"
                      maxLength={600}
                    />
                  </label>
                </div>

                {error ? (
                  <div className="mt-3 rounded-xl border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
                    {error}
                  </div>
                ) : null}

                <div className="mt-4 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => refreshPosts({ silent: false })}
                    className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs font-mono uppercase tracking-[0.22em] text-slate-200 hover:border-slate-700"
                  >
                    <span className="inline-flex items-center gap-2">
                      <RefreshCw className="h-4 w-4" />
                      Refresh
                    </span>
                  </button>

                  <button
                    type="submit"
                    disabled={submitting || !alias.trim() || !content.trim()}
                    className={cn(
                      'rounded-xl px-4 py-2 text-xs font-mono uppercase tracking-[0.22em] transition',
                      'border border-emerald-900/60 bg-emerald-950/40 text-emerald-200',
                      'hover:border-emerald-800 hover:bg-emerald-950/55',
                      'disabled:cursor-not-allowed disabled:opacity-50',
                    )}
                  >
                    {submitting ? 'Broadcasting…' : 'Broadcast'}
                  </button>
                </div>
              </form>
            </div>
          </section>

          <section className={cn('lg:col-span-7', tab !== 'board' ? 'hidden lg:block' : '')}>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/40 backdrop-blur">
              <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
                <div className="text-sm font-semibold text-slate-100">Community Board</div>
                <button
                  type="button"
                  onClick={() => refreshPosts({ silent: false })}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/30 px-3 py-2 text-xs text-slate-200 hover:border-slate-700"
                >
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </button>
              </div>

              <div className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs text-slate-400">
                    {loading ? 'Syncing…' : `${posts.length} message${posts.length === 1 ? '' : 's'}`}
                  </div>
                  <div className="text-xs text-slate-500">Auto refresh: 5s</div>
                </div>
              </div>

              <div
                ref={listRef}
                className="max-h-[62vh] overflow-auto border-t border-slate-800"
              >
                {posts.length === 0 ? (
                  <div className="px-4 py-8 text-center">
                    <div className="mx-auto w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-950/40 p-5">
                      <div className="text-sm font-mono text-slate-200">No broadcasts yet.</div>
                      <div className="mt-2 text-xs text-slate-500">
                        Use the Broadcast panel to post the first status update.
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-3 p-4">
                    {posts.map((m) => {
                      const meta = statusMeta(m.status)
                      const Icon = meta.icon
                      return (
                        <article
                          key={m.id || `${m.alias}-${m.timestamp}-${m.content}`}
                          className="rounded-2xl border border-slate-800 bg-slate-950/35 p-4"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <div className={cn('inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-mono tracking-[0.18em]', meta.badge)}>
                                  <Icon className={cn('h-3.5 w-3.5', meta.accent)} />
                                  <span>{meta.label}</span>
                                </div>
                                <div className="truncate text-sm font-medium text-slate-100">{m.alias || 'Anonymous'}</div>
                              </div>
                              <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-100">
                                {m.content}
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div className="text-xs text-slate-500">{relativeTime(m.timestamp) || '—'}</div>
                            </div>
                          </div>
                        </article>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  )
}
