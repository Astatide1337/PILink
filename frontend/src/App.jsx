import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bot,
  MessageCircle,
  Mic,
  MicOff,
  MoreVertical,
  Phone,
  PhoneOff,
  Radio,
  Send,
  Trash2,
  User,
  X,
  Wifi,
  WifiOff,
} from 'lucide-react'

// ── utils ──────────────────────────────────────────────────────────────────────

function cn(...xs) {
  return xs.filter(Boolean).join(' ')
}

function relTime(ts) {
  if (!ts) return ''
  const s = Math.floor((Date.now() / 1000) - ts)
  if (s < 0) return 'now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ── app ────────────────────────────────────────────────────────────────────────

export default function App() {
  // ── name ──
  const [name, setName] = useState(() => localStorage.getItem('pilink.name') || '')
  const [nameInput, setNameInput] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showMenu, setShowMenu] = useState(false)

  // ── tabs ──
  const [tab, setTab] = useState('chat')

  // ── ws + connection ──
  const wsRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const pingRef = useRef(null)

  // ── chat ──
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const chatEndRef = useRef(null)

  // ── identity ──
  const [peerId, setPeerId] = useState(null)
  const peerIdRef = useRef(null)

  // ── voice ──
  const [inVoice, setInVoice] = useState(false)
  const inVoiceRef = useRef(false)
  const [voicePeers, setVoicePeers] = useState([])
  const [floorHolder, setFloorHolder] = useState(null)
  const floorHolderRef = useRef(null)
  const [floorDenied, setFloorDenied] = useState(false)
  const pttDownRef = useRef(false)
  const heartbeatRef = useRef(null)
  const localStreamRef = useRef(null)
  const pcsRef = useRef({})       // peerId → RTCPeerConnection
  const audiosRef = useRef({})    // peerId → HTMLAudioElement

  // ── ai ──
  const [aiAvailable, setAiAvailable] = useState(null)
  const [aiReason, setAiReason] = useState(null)
  const [aiWant, setAiWant] = useState(null)
  const [aiChat, setAiChat] = useState([])
  const [aiDraft, setAiDraft] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const aiEndRef = useRef(null)

  // ── helpers ──
  function wsSend(data) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }

  function startPing() {
    stopPing()
    pingRef.current = setInterval(() => wsSend({ type: 'ping' }), 20000)
  }

  function stopPing() {
    if (pingRef.current) {
      clearInterval(pingRef.current)
      pingRef.current = null
    }
  }

  function startHeartbeat() {
    stopHeartbeat()
    heartbeatRef.current = setInterval(() => wsSend({ type: 'floor:heartbeat' }), 2000)
  }

  function stopHeartbeat() {
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null }
  }

  // ── WebRTC helpers (use refs only, safe in any closure) ──

  function createPC(remotePeerId) {
    if (pcsRef.current[remotePeerId]) pcsRef.current[remotePeerId].close()

    // No STUN/TURN — all peers are on the same LAN.
    const pc = new RTCPeerConnection({ iceServers: [] })

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => pc.addTrack(t, localStreamRef.current))
    }

    pc.ontrack = (e) => {
      const audio = new Audio()
      audio.srcObject = e.streams[0]
      const holder = floorHolderRef.current
      audio.muted = !holder || holder.id !== remotePeerId
      audio.play().catch(() => {})
      audiosRef.current[remotePeerId] = audio
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        wsSend({ type: 'webrtc:ice', payload: { to: remotePeerId, candidate: e.candidate.toJSON() } })
      }
    }

    pcsRef.current[remotePeerId] = pc
    return pc
  }

  async function connectToPeer(remotePeerId) {
    const pc = createPC(remotePeerId)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    wsSend({ type: 'webrtc:offer', payload: { to: remotePeerId, sdp: offer.sdp } })
  }

  async function handleOffer({ from, sdp }) {
    const pc = createPC(from)
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }))
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    wsSend({ type: 'webrtc:answer', payload: { to: from, sdp: answer.sdp } })
  }

  async function handleAnswer({ from, sdp }) {
    const pc = pcsRef.current[from]
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }))
  }

  async function handleIce({ from, candidate }) {
    const pc = pcsRef.current[from]
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)) } catch {}
    }
  }

  function closePeer(id) {
    pcsRef.current[id]?.close()
    delete pcsRef.current[id]
    const a = audiosRef.current[id]
    if (a) { a.pause(); a.srcObject = null; delete audiosRef.current[id] }
  }

  function cleanupVoiceLocal() {
    Object.keys(pcsRef.current).forEach(closePeer)
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop())
      localStreamRef.current = null
    }
    stopHeartbeat()
    pttDownRef.current = false
    inVoiceRef.current = false
    setInVoice(false)
    setVoicePeers([])
    setFloorHolder(null)
    floorHolderRef.current = null
  }

  // ── WebSocket connection ──

  useEffect(() => {
    if (!name) return

    let alive = true
    let timer = null

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${location.host}/api/ws`)
      wsRef.current = ws

      ws.onopen = () => setConnected(true)

      ws.onclose = () => {
        setConnected(false)
        wsRef.current = null
        stopPing()
        if (inVoiceRef.current) cleanupVoiceLocal()
        if (alive) timer = setTimeout(connect, 3000)
      }

      ws.onerror = () => {} // onclose fires after

      ws.onmessage = (e) => {
        let data
        try { data = JSON.parse(e.data) } catch { return }

        switch (data.type) {
          case 'pong':
            break
          case 'self:id':
            peerIdRef.current = data.payload.id
            setPeerId(data.payload.id)
            break

          case 'history':
            setMessages(data.payload || [])
            break

          case 'message:new':
            setMessages(prev => [...prev, data.payload])
            break

          case 'message:delete':
            setMessages(prev => prev.filter(m => m.id !== data.payload.id))
            break

          case 'chat:clear':
            setMessages([])
            break

          case 'voice:peers':
            setVoicePeers(data.payload || [])
            break

          // Server sends this ONLY to the joining client with the pre-existing
          // peer list. The joiner creates WebRTC offers to each existing peer.
          case 'voice:joined':
            if (inVoiceRef.current && Array.isArray(data.payload)) {
              for (const peer of data.payload) {
                connectToPeer(peer.id).catch(() => {})
              }
            }
            break

          case 'voice:join':
            setVoicePeers(prev => {
              if (prev.some(p => p.id === data.payload.id)) return prev
              return [...prev, data.payload]
            })

            // If we're already in voice, ensure we connect to the newcomer.
            // Deterministic offerer to reduce glare: lexicographically smaller id initiates.
            if (inVoiceRef.current && peerIdRef.current && data.payload?.id && data.payload.id !== peerIdRef.current) {
              if (!pcsRef.current[data.payload.id] && String(peerIdRef.current) < String(data.payload.id)) {
                connectToPeer(data.payload.id).catch(() => {})
              }
            }
            break

          case 'voice:leave':
            setVoicePeers(prev => prev.filter(p => p.id !== data.payload.id))
            closePeer(data.payload.id)
            break

          case 'floor:state':
            floorHolderRef.current = data.payload.holder
            setFloorHolder(data.payload.holder)
            break

          case 'floor:denied':
            setFloorDenied(true)
            setTimeout(() => setFloorDenied(false), 1200)
            break

          case 'webrtc:offer':
            handleOffer(data.payload).catch(() => {})
            break
          case 'webrtc:answer':
            handleAnswer(data.payload).catch(() => {})
            break
          case 'webrtc:ice':
            handleIce(data.payload).catch(() => {})
            break
        }
      }

      ws.addEventListener('open', startPing)
    }

    connect()
    return () => { alive = false; clearTimeout(timer); stopPing(); wsRef.current?.close() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

  // ── Mute/unmute remote audio based on floor holder ──

  useEffect(() => {
    Object.entries(audiosRef.current).forEach(([id, audio]) => {
      audio.muted = !floorHolder || floorHolder.id !== id
    })
  }, [floorHolder])

  // When floor is granted to us and we're still pressing PTT, enable mic.
  useEffect(() => {
    if (!floorHolder || !peerIdRef.current) return
    if (floorHolder.id === peerIdRef.current) {
      if (pttDownRef.current) {
        localStreamRef.current?.getAudioTracks().forEach(t => { t.enabled = true })
        startHeartbeat()
      } else {
        // Released before grant arrived — release immediately
        wsSend({ type: 'floor:release' })
      }
    } else {
      localStreamRef.current?.getAudioTracks().forEach(t => { t.enabled = false })
      stopHeartbeat()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floorHolder])

  // Auto-scroll chat
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => { aiEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [aiChat])

  // ── voice actions ──

  async function joinVoice() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getAudioTracks().forEach(t => { t.enabled = false })
      localStreamRef.current = stream
      inVoiceRef.current = true
      setInVoice(true)
      wsSend({ type: 'voice:join', payload: { name } })
    } catch {
      alert('Microphone access required for voice channel.')
    }
  }

  function leaveVoice() {
    if (floorHolderRef.current?.id === peerIdRef.current) {
      wsSend({ type: 'floor:release' })
    }
    wsSend({ type: 'voice:leave' })
    cleanupVoiceLocal()
  }

  function onPttDown(e) {
    e.preventDefault()
    if (!inVoiceRef.current) return
    pttDownRef.current = true
    wsSend({ type: 'floor:request' })
  }

  function onPttUp(e) {
    e.preventDefault()
    pttDownRef.current = false
    if (floorHolderRef.current?.id === peerIdRef.current) {
      localStreamRef.current?.getAudioTracks().forEach(t => { t.enabled = false })
      stopHeartbeat()
      wsSend({ type: 'floor:release' })
    }
  }

  // ── chat actions ──

  function sendMessage(e) {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    wsSend({ type: 'message:send', payload: { sender: name, content: text } })
    setDraft('')
  }

  function deleteMessage(id) {
    wsSend({ type: 'message:delete', payload: { id } })
  }

  function clearChat() {
    wsSend({ type: 'chat:clear' })
    setShowMenu(false)
  }

  // ── AI ──

  useEffect(() => {
    if (tab !== 'ai') return
    let cancelled = false
    fetch('/api/ai/health').then(r => r.json()).then(d => {
      if (cancelled) return
      setAiAvailable(Boolean(d.available))
      setAiReason(d.reason || null)
      setAiWant(d.want || null)
    }).catch(() => { if (!cancelled) setAiAvailable(false) })
    return () => { cancelled = true }
  }, [tab])

  async function askAi(e) {
    e.preventDefault()
    const q = aiDraft.trim()
    if (!q || aiBusy) return
    setAiBusy(true)
    setAiDraft('')
    setAiChat(prev => [...prev, { role: 'user', text: q }])

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 60000)
    try {
      // Stream tokens if available.
      const res = await fetch('/api/ai/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
        signal: ac.signal,
      })

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        const msg = data?.error ? String(data.error) : `HTTP ${res.status}`
        throw new Error(msg)
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error('Streaming unsupported')

      // Create the AI message once, then append tokens as they arrive.
      let aiText = ''
      setAiChat(prev => [...prev, { role: 'ai', text: '' }])

      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })

        let idx
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (!line) continue
          let obj
          try { obj = JSON.parse(line) } catch { continue }
          if (obj.token) {
            aiText += String(obj.token)
            setAiChat(prev => {
              const next = prev.slice()
              const last = next[next.length - 1]
              if (last?.role === 'ai') next[next.length - 1] = { ...last, text: aiText }
              return next
            })
          }
          if (obj.done) {
            return
          }
        }
      }
    } catch (err) {
      setAiChat(prev => [...prev, { role: 'ai', text: `Error: ${err.message}` }])
    } finally {
      clearTimeout(timer)
      setAiBusy(false)
    }
  }

  // ── name save helper ──
  function saveName(n) {
    const trimmed = n.trim().slice(0, 32)
    if (!trimmed) return
    localStorage.setItem('pilink.name', trimmed)
    setName(trimmed)
    setShowSettings(false)
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════

  // ── first-run: name required ──

  if (!name) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
        <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/80 p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="grid h-10 w-10 place-items-center rounded-xl border border-slate-700 bg-slate-800">
              <Radio className="h-5 w-5 text-emerald-400" />
            </div>
            <div>
              <div className="text-base font-semibold text-slate-100">PILink</div>
              <div className="text-xs text-slate-400">Offline mesh communicator</div>
            </div>
          </div>
          <label className="block mb-1 text-xs text-slate-400">Display name</label>
          <input
            autoFocus
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && saveName(nameInput)}
            placeholder="Your name or callsign"
            maxLength={32}
            className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/40"
          />
          <button
            onClick={() => saveName(nameInput)}
            disabled={!nameInput.trim()}
            className="mt-4 w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            Continue
          </button>
          <p className="mt-4 text-[11px] text-slate-500 text-center leading-relaxed">
            If pilink.astatide.com doesn't load, try{' '}
            <span className="text-slate-400">https://10.42.0.1</span>
          </p>
        </div>
      </div>
    )
  }

  // ── main app ──

  const iAmSpeaking = floorHolder?.id === peerId
  const someoneElseSpeaking = floorHolder && floorHolder.id !== peerId

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      {/* ── header ── */}
      <header className="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Radio className="h-5 w-5 text-emerald-400" />
            <span className="text-sm font-semibold tracking-tight">PILink</span>
            {connected
              ? <span className="ml-1.5 h-2 w-2 rounded-full bg-emerald-400" title="Connected" />
              : <span className="ml-1.5 h-2 w-2 rounded-full bg-red-400 animate-pulse" title="Disconnected" />}
          </div>

          <div className="flex items-center gap-2">
            {/* user badge — tap to edit name */}
            <button
              onClick={() => { setNameInput(name); setShowSettings(true) }}
              className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/60 px-2.5 py-1.5 text-xs text-slate-300 hover:border-slate-700 transition"
            >
              <User className="h-3.5 w-3.5" />
              <span className="max-w-[100px] truncate">{name}</span>
            </button>

            {/* menu */}
            <div className="relative">
              <button
                onClick={() => setShowMenu(!showMenu)}
                className="rounded-lg border border-slate-800 bg-slate-900/60 p-1.5 text-slate-400 hover:text-slate-200 hover:border-slate-700 transition"
              >
                <MoreVertical className="h-4 w-4" />
              </button>
              {showMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                  <div className="absolute right-0 z-50 mt-1 w-44 rounded-xl border border-slate-800 bg-slate-900 shadow-xl">
                    <button
                      onClick={clearChat}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-xs text-red-400 hover:bg-slate-800 rounded-xl transition"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Clear all messages
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── tabs ── */}
        <div className="mx-auto flex max-w-2xl px-4 pb-2 gap-1">
          <button
            onClick={() => setTab('chat')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium transition',
              tab === 'chat'
                ? 'bg-emerald-600/15 text-emerald-400 border border-emerald-600/30'
                : 'text-slate-400 hover:text-slate-200 border border-transparent'
            )}
          >
            <MessageCircle className="h-3.5 w-3.5" /> Chat
          </button>
          <button
            onClick={() => setTab('ai')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium transition',
              tab === 'ai'
                ? 'bg-emerald-600/15 text-emerald-400 border border-emerald-600/30'
                : 'text-slate-400 hover:text-slate-200 border border-transparent'
            )}
          >
            <Bot className="h-3.5 w-3.5" /> PI
          </button>
        </div>
      </header>

      {/* ── content ── */}
      <main className="flex-1 mx-auto w-full max-w-2xl flex flex-col">

        {/* ──────────── CHAT TAB ──────────── */}
        {tab === 'chat' && (
          <div className="flex flex-1 flex-col">
            {/* voice channel panel */}
            <div className="border-b border-slate-800 px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <Mic className="h-3.5 w-3.5" />
                  <span>Voice Channel</span>
                  {voicePeers.length > 0 && (
                    <span className="text-emerald-400 font-medium">{voicePeers.length} in channel</span>
                  )}
                </div>
                {!inVoice ? (
                  <button
                    onClick={joinVoice}
                    disabled={!connected}
                    className="flex items-center gap-1.5 rounded-lg bg-emerald-600/15 border border-emerald-600/30 px-3 py-1.5 text-xs font-medium text-emerald-400 hover:bg-emerald-600/25 disabled:opacity-40 transition"
                  >
                    <Phone className="h-3.5 w-3.5" /> Join
                  </button>
                ) : (
                  <button
                    onClick={leaveVoice}
                    className="flex items-center gap-1.5 rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/20 transition"
                  >
                    <PhoneOff className="h-3.5 w-3.5" /> Leave
                  </button>
                )}
              </div>

              {/* participant names */}
              {voicePeers.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {voicePeers.map(p => (
                    <span
                      key={p.id}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px]',
                        floorHolder?.id === p.id
                          ? 'bg-red-500/15 text-red-300 border border-red-500/30'
                          : 'bg-slate-800 text-slate-400 border border-slate-700'
                      )}
                    >
                      {floorHolder?.id === p.id && <span className="h-1.5 w-1.5 rounded-full bg-red-400 animate-pulse" />}
                      {p.name}
                      {p.id === peerId && <span className="text-slate-500">(you)</span>}
                    </span>
                  ))}
                </div>
              )}

              {/* PTT button — only visible when in voice */}
              {inVoice && (
                <div className="flex flex-col items-center gap-1.5">
                  {floorHolder && floorHolder.id !== peerId && (
                    <div className="text-[11px] text-amber-400">
                      {floorHolder.name} is speaking…
                    </div>
                  )}

                  <button
                    onPointerDown={onPttDown}
                    onPointerUp={onPttUp}
                    onPointerCancel={onPttUp}
                    onContextMenu={e => e.preventDefault()}
                    disabled={someoneElseSpeaking}
                    className={cn(
                      'w-full max-w-xs rounded-xl py-3 text-sm font-medium select-none touch-none transition',
                      iAmSpeaking
                        ? 'bg-red-500/20 border-2 border-red-500 text-red-300 animate-pulse'
                        : floorDenied
                          ? 'bg-amber-500/10 border-2 border-amber-500/40 text-amber-400'
                          : someoneElseSpeaking
                            ? 'bg-slate-800 border-2 border-slate-700 text-slate-500 cursor-not-allowed'
                            : 'bg-slate-800 border-2 border-slate-700 text-slate-300 hover:border-slate-600 active:bg-emerald-600/15 active:border-emerald-500 active:text-emerald-300'
                    )}
                  >
                    {iAmSpeaking ? (
                      <span className="flex items-center justify-center gap-2">
                        <Mic className="h-4 w-4" /> Speaking…
                      </span>
                    ) : floorDenied ? (
                      <span className="flex items-center justify-center gap-2">
                        <MicOff className="h-4 w-4" /> Floor busy
                      </span>
                    ) : someoneElseSpeaking ? (
                      <span className="flex items-center justify-center gap-2">
                        <MicOff className="h-4 w-4" /> Floor busy
                      </span>
                    ) : (
                      <span className="flex items-center justify-center gap-2">
                        <Mic className="h-4 w-4" /> Hold to Talk
                      </span>
                    )}
                  </button>
                </div>
              )}
            </div>

            {/* message list */}
            <div className="flex-1 overflow-y-auto scroll-thin px-4 py-3 space-y-2" style={{ minHeight: 0 }}>
              {messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-500 text-sm">
                  <MessageCircle className="h-8 w-8 mb-2 text-slate-600" />
                  No messages yet
                </div>
              ) : (
                messages.map(m => (
                  <div key={m.id} className="group flex gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="text-xs font-medium text-emerald-400 truncate">{m.sender}</span>
                        <span className="text-[10px] text-slate-500 shrink-0">{relTime(m.timestamp)}</span>
                      </div>
                      <div className="text-sm text-slate-200 break-words whitespace-pre-wrap mt-0.5">
                        {m.content}
                      </div>
                    </div>
                    <button
                      onClick={() => deleteMessage(m.id)}
                      className="opacity-0 group-hover:opacity-100 shrink-0 self-start mt-1 p-1 text-slate-500 hover:text-red-400 transition"
                      title="Delete message"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
              <div ref={chatEndRef} />
            </div>

            {/* message input */}
            <form onSubmit={sendMessage} className="border-t border-slate-800 px-4 py-3 flex gap-2">
              <input
                value={draft}
                onChange={e => setDraft(e.target.value)}
                placeholder="Type a message…"
                maxLength={600}
                className="flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/40"
              />
              <button
                type="submit"
                disabled={!draft.trim() || !connected}
                className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </div>
        )}

        {/* ──────────── AI TAB ──────────── */}
        {tab === 'ai' && (
          <div className="flex flex-1 flex-col">
            {/* status bar */}
            <div className="border-b border-slate-800 px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs">
                <Bot className="h-4 w-4 text-emerald-400" />
                <span className="font-medium text-slate-200">PI</span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px]">
                {aiAvailable === null ? (
                  <span className="text-slate-500">checking…</span>
                ) : aiAvailable ? (
                  <>
                    <span className="h-2 w-2 rounded-full bg-emerald-400" />
                    <span className="text-emerald-400">Available</span>
                  </>
                ) : (
                  <>
                    <span className="h-2 w-2 rounded-full bg-red-400" />
                    <span className="text-red-400">Unavailable</span>
                  </>
                )}
              </div>
            </div>

            {/* ai chat messages */}
            <div className="flex-1 overflow-y-auto scroll-thin px-4 py-3 space-y-3" style={{ minHeight: 0 }}>
              {aiChat.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-500 text-sm text-center px-6">
                  <Bot className="h-8 w-8 mb-2 text-slate-600" />
                  <p>Ask PI anything. PI also knows how PILink works and can help troubleshoot.</p>
                  <div className="mt-3 grid w-full max-w-sm gap-2">
                    {[
                      'Why is my voice channel not working on iPhone?',
                      'How can I improve PILink range?',
                      'Summarize the last few messages.',
                      'Draft a calm announcement for the group.',
                    ].map((s) => (
                      <button
                        key={s}
                        onClick={() => setAiDraft(s)}
                        className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-left text-xs text-slate-300 hover:border-slate-700"
                      >
                        {s}
                      </button>
                    ))}
                  </div>

                  {aiAvailable === false && aiReason === 'model_missing' && aiWant && (
                    <div className="mt-3 w-full max-w-sm rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-left text-xs text-amber-300">
                      Model missing. On the Pi run: <span className="text-amber-200">ollama pull {aiWant}</span>
                    </div>
                  )}
                  {aiAvailable === false && aiReason === 'ollama_down' && (
                    <div className="mt-3 w-full max-w-sm rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-left text-xs text-amber-300">
                      Ollama is offline on this node. On the Pi run: <span className="text-amber-200">sudo systemctl start ollama</span>
                    </div>
                  )}
                </div>
              ) : (
                aiChat.map((m, i) => (
                  <div
                    key={i}
                    className={cn(
                      'rounded-xl border px-3 py-2.5 text-sm leading-relaxed',
                      m.role === 'user'
                        ? 'ml-8 border-slate-700 bg-slate-800/60 text-slate-100'
                        : 'mr-8 border-emerald-900/40 bg-emerald-950/20 text-emerald-100'
                    )}
                  >
                    <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                      {m.role === 'user' ? 'You' : 'PI'}
                    </div>
                    <div className="whitespace-pre-wrap break-words">{m.text}</div>
                  </div>
                ))
              )}
              {aiBusy && (
                <div className="mr-8 rounded-xl border border-emerald-900/40 bg-emerald-950/20 px-3 py-2.5 text-sm text-emerald-200">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                    Thinking…
                  </div>
                </div>
              )}
              <div ref={aiEndRef} />
            </div>

            {/* ai input */}
            <form onSubmit={askAi} className="border-t border-slate-800 px-4 py-3 flex gap-2">
              <input
                value={aiDraft}
                onChange={e => setAiDraft(e.target.value)}
                placeholder="Ask PI anything…"
                maxLength={320}
                className="flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/40"
              />
              <button
                type="submit"
                disabled={!aiDraft.trim() || aiBusy}
                className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </div>
        )}
      </main>

      {/* ── settings modal ── */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={() => setShowSettings(false)}>
          <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-slate-200">Change name</span>
              <button onClick={() => setShowSettings(false)} className="text-slate-400 hover:text-slate-200">
                <X className="h-4 w-4" />
              </button>
            </div>
            <input
              autoFocus
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveName(nameInput)}
              maxLength={32}
              className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/40"
            />
            <button
              onClick={() => saveName(nameInput)}
              disabled={!nameInput.trim()}
              className="mt-3 w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40 transition"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {/* ── disconnected banner ── */}
      {!connected && (
        <div className="fixed bottom-0 inset-x-0 z-40 bg-amber-500/10 border-t border-amber-500/30 px-4 py-2 text-center text-xs text-amber-300">
          <WifiOff className="inline h-3.5 w-3.5 mr-1.5" />
          Connection lost — reconnecting…
        </div>
      )}
    </div>
  )
}
