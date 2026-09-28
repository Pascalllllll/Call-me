// Mesh call with three fixed transceivers per peer (mic, camera, screen) swapped via replaceTrack:
// no renegotiation after setup, and only the later joiner sends offers, so offers never collide.
const AUDIO = 0;
const CAMERA = 1;
const SCREEN = 2;
const SPEAKING_THRESHOLD = 0.02;

function cameraBitrate(peerCount) {
  if (peerCount <= 1) return 1_500_000;
  if (peerCount <= 3) return 900_000;
  if (peerCount <= 7) return 450_000;
  if (peerCount <= 15) return 250_000;
  return 150_000;
}

export class CallSession {
  constructor({ send, iceServers, onChange, onSpeaking, onError }) {
    this.send = send;
    this.iceServers = iceServers;
    this.onChange = onChange;
    this.onSpeaking = onSpeaking;
    this.onError = onError;
    this.channelId = null;
    this.selfPeerId = null;
    this.peers = new Map();
    this.mic = null;
    this.camera = null;
    this.screen = null;
    this.muted = false;
    this.deafened = false;
    this.mutedBeforeDeafen = false;
    this.localVideo = document.createElement('video');
    this.localVideo.muted = true;
    this.localVideo.playsInline = true;
    this.localVideo.autoplay = true;
    this.localScreen = document.createElement('video');
    this.localScreen.muted = true;
    this.localScreen.playsInline = true;
    this.localScreen.autoplay = true;
    this.audioCtx = null;
    this.meters = new Map();
    this.speaking = new Map();
    this.meterTimer = null;
  }

  async prepare() {
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.#addMeter('self', this.mic);
    } catch (err) {
      this.mic = null;
      this.muted = true;
      this.onError?.(
        err?.name === 'NotAllowedError'
          ? 'Microphone access was blocked, so you joined listen-only. Allow the mic in your browser to talk.'
          : 'No microphone found, so you joined listen-only.',
      );
    }
    if (this.mic) this.mic.getAudioTracks()[0].enabled = !this.muted;
  }

  // Server confirmed our join: we initiate a connection to everyone already there.
  joined({ channelId, selfPeerId, peers }) {
    this.channelId = channelId;
    this.selfPeerId = selfPeerId;
    for (const info of peers) this.#createPeer(info.peerId, true);
    this.#adaptBitrates();
    this.#startMeters();
    this.onChange();
  }

  peerJoined(info) {
    // The newcomer sends the offer; we only create the connection when it arrives.
    if (!this.peers.has(info.peerId)) this.onChange();
  }

  peerLeft(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.pc.close();
    peer.audio.srcObject = null;
    peer.audio.remove();
    this.#removeMeter(peerId);
    this.peers.delete(peerId);
    this.#adaptBitrates();
    this.onChange();
  }

  async signal(from, data) {
    let peer = this.peers.get(from);
    try {
      if (data.description) {
        const desc = data.description;
        if (desc.type === 'offer') {
          if (!peer) peer = this.#createPeer(from, false);
          if (peer.initiator) return; // Only the newcomer offers; ignore unexpected offers.
          await peer.pc.setRemoteDescription(desc);
          this.#attachLocalTracks(peer);
          await peer.pc.setLocalDescription(await peer.pc.createAnswer());
          this.send({ type: 'signal', to: from, data: { description: peer.pc.localDescription.toJSON() } });
          this.#adaptBitrates();
        } else if (desc.type === 'answer' && peer?.initiator) {
          await peer.pc.setRemoteDescription(desc);
        }
        if (peer) {
          for (const c of peer.pendingCandidates.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
        }
      } else if (data.candidate && peer) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.pendingCandidates.push(data.candidate);
      }
    } catch (err) {
      console.warn('Signal handling failed', err);
    }
  }

  #createPeer(peerId, initiator) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.muted = this.deafened;
    audio.hidden = true;
    document.body.append(audio);

    const peer = {
      peerId,
      pc,
      initiator,
      audio,
      pendingCandidates: [],
      streams: { audio: null, camera: null, screen: null },
      cameraEl: null,
      screenEl: null,
      state: 'connecting',
    };
    this.peers.set(peerId, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ type: 'signal', to: peerId, data: { candidate: e.candidate.toJSON() } });
    };
    pc.ontrack = (e) => {
      const index = pc.getTransceivers().indexOf(e.transceiver);
      const stream = new MediaStream([e.track]);
      if (index === AUDIO) {
        peer.streams.audio = stream;
        audio.srcObject = stream;
        audio.play().catch(() => {});
        this.#addMeter(peerId, stream);
      } else if (index === CAMERA) {
        peer.streams.camera = stream;
        peer.cameraEl = this.#videoFor(stream);
      } else if (index === SCREEN) {
        peer.streams.screen = stream;
        peer.screenEl = this.#videoFor(stream);
      }
      this.onChange();
    };
    pc.onconnectionstatechange = () => {
      peer.state = pc.connectionState;
      if (pc.connectionState === 'failed' && initiator) pc.restartIce();
      this.onChange();
    };
    if (initiator) {
      pc.onnegotiationneeded = async () => {
        try {
          await pc.setLocalDescription(await pc.createOffer());
          this.send({ type: 'signal', to: peerId, data: { description: pc.localDescription.toJSON() } });
        } catch (err) {
          console.warn('Offer failed', err);
        }
      };
      pc.addTransceiver(this.mic?.getAudioTracks()[0] ?? 'audio', { direction: 'sendrecv' });
      pc.addTransceiver(this.camera?.getVideoTracks()[0] ?? 'video', { direction: 'sendrecv' });
      pc.addTransceiver(this.screen?.getVideoTracks()[0] ?? 'video', { direction: 'sendrecv' });
    }
    return peer;
  }

  #attachLocalTracks(peer) {
    const t = peer.pc.getTransceivers();
    if (t.length < 3) return;
    const tracks = [
      this.mic?.getAudioTracks()[0] ?? null,
      this.camera?.getVideoTracks()[0] ?? null,
      this.screen?.getVideoTracks()[0] ?? null,
    ];
    t.slice(0, 3).forEach((tr, i) => {
      tr.direction = 'sendrecv';
      tr.sender.replaceTrack(tracks[i]).catch(() => {});
    });
  }

  #videoFor(stream) {
    const v = document.createElement('video');
    v.autoplay = true;
    v.playsInline = true;
    v.muted = true; // audio plays through the separate <audio> element
    v.srcObject = stream;
    return v;
  }

  #replaceTrack(index, track) {
    for (const peer of this.peers.values()) {
      const tr = peer.pc.getTransceivers()[index];
      tr?.sender.replaceTrack(track).catch(() => {});
    }
  }

  #adaptBitrates() {
    const n = this.peers.size;
    for (const peer of this.peers.values()) {
      const t = peer.pc.getTransceivers();
      const tune = (tr, maxBitrate) => {
        if (!tr) return;
        const params = tr.sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) return;
        params.encodings[0].maxBitrate = maxBitrate;
        tr.sender.setParameters(params).catch(() => {});
      };
      tune(t[CAMERA], cameraBitrate(n));
      tune(t[SCREEN], Math.max(600_000, Math.floor(4_000_000 / Math.max(1, n))));
    }
  }

  setMuted(muted) {
    if (!this.mic) {
      this.onError?.('No microphone available.');
      return;
    }
    if (!muted && this.deafened) {
      this.mutedBeforeDeafen = false;
      this.setDeafened(false);
      return;
    }
    this.muted = muted;
    this.mic.getAudioTracks()[0].enabled = !muted;
    this.#publishState();
  }

  setDeafened(deafened) {
    if (deafened === this.deafened) return;
    this.deafened = deafened;
    for (const peer of this.peers.values()) peer.audio.muted = deafened;
    // Deafening also mutes; undeafening restores whatever the mic was before.
    if (deafened) this.mutedBeforeDeafen = this.muted;
    if (this.mic) {
      this.muted = deafened ? true : this.mutedBeforeDeafen;
      this.mic.getAudioTracks()[0].enabled = !this.muted;
    }
    this.#publishState();
  }

  async toggleCamera() {
    if (this.camera) {
      this.camera.getTracks().forEach((t) => t.stop());
      this.camera = null;
      this.localVideo.srcObject = null;
      this.#replaceTrack(CAMERA, null);
    } else {
      try {
        this.camera = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        });
      } catch {
        this.onError?.('Camera access was blocked or no camera was found.');
        return;
      }
      this.localVideo.srcObject = this.camera;
      this.#replaceTrack(CAMERA, this.camera.getVideoTracks()[0]);
    }
    this.#publishState();
  }

  async toggleScreen() {
    if (this.screen) {
      this.#stopScreen();
      return;
    }
    try {
      this.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: false });
    } catch {
      return; // user cancelled the picker
    }
    const track = this.screen.getVideoTracks()[0];
    track.contentHint = 'detail';
    track.addEventListener('ended', () => this.#stopScreen());
    this.localScreen.srcObject = this.screen;
    this.#replaceTrack(SCREEN, track);
    this.#publishState();
  }

  #stopScreen() {
    if (!this.screen) return;
    this.screen.getTracks().forEach((t) => t.stop());
    this.screen = null;
    this.localScreen.srcObject = null;
    this.#replaceTrack(SCREEN, null);
    this.#publishState();
  }

  #publishState() {
    this.send({
      type: 'voice.update',
      muted: this.muted,
      deafened: this.deafened,
      video: Boolean(this.camera),
      screen: Boolean(this.screen),
    });
    this.onChange();
  }

  initialState() {
    return { muted: this.muted, deafened: this.deafened, video: false, screen: false };
  }

  #addMeter(key, stream) {
    try {
      this.audioCtx ??= new AudioContext();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
      const source = this.audioCtx.createMediaStreamSource(stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      this.#removeMeter(key);
      this.meters.set(key, { source, analyser, buf: new Float32Array(analyser.fftSize) });
    } catch {
      // Level metering is cosmetic; calls work without it.
    }
  }

  #removeMeter(key) {
    const m = this.meters.get(key);
    if (m) m.source.disconnect();
    this.meters.delete(key);
    this.speaking.delete(key);
  }

  #startMeters() {
    if (this.meterTimer) return;
    this.meterTimer = setInterval(() => {
      for (const [key, m] of this.meters) {
        m.analyser.getFloatTimeDomainData(m.buf);
        let sum = 0;
        for (const x of m.buf) sum += x * x;
        const rms = Math.sqrt(sum / m.buf.length);
        const muted = key === 'self' ? this.muted : false;
        const speaking = !muted && rms > SPEAKING_THRESHOLD;
        if (speaking !== Boolean(this.speaking.get(key))) {
          this.speaking.set(key, speaking);
          this.onSpeaking?.(key === 'self' ? this.selfPeerId : key, speaking);
        }
      }
    }, 150);
  }

  leave() {
    clearInterval(this.meterTimer);
    this.meterTimer = null;
    for (const peerId of [...this.peers.keys()]) this.peerLeft(peerId);
    for (const s of [this.mic, this.camera, this.screen]) s?.getTracks().forEach((t) => t.stop());
    this.mic = this.camera = this.screen = null;
    this.localVideo.srcObject = null;
    this.localScreen.srcObject = null;
    this.meters.clear();
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.channelId = null;
  }
}
