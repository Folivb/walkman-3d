import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

// ==========================================
// 1. SPOTIFY AUTH (PKCE) & WEB PLAYBACK
// ==========================================
const SpotifyAuth = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0,
  deviceId: null,
  isConnected: false,
  currentTrack: null,
  isPlaying: false,
  volume: 0.7,
  playlists: [],
  playlistIndex: 0,

  init() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (code) {
      this.exchangeCode(code).then(() => {
        window.history.replaceState({}, '', window.location.pathname);
        this.onConnected();
      }).catch(err => {
        console.error('Spotify auth error:', err);
        showToast('Error al conectar con Spotify');
      });
    }

    const saved = localStorage.getItem('spotify_tokens');
    if (saved) {
      const tokens = JSON.parse(saved);
      this.accessToken = tokens.accessToken;
      this.refreshToken = tokens.refreshToken;
      this.expiresAt = tokens.expiresAt;
      if (Date.now() < this.expiresAt - 60000) {
        this.isConnected = true;
        this.updateUI();
        this.initPlaybackSDK();
        this.getPlaybackState();
        this.fetchPlaylists();
      } else if (this.refreshToken) {
        this.refreshAccessToken().then(() => {
          this.isConnected = true;
          this.updateUI();
          this.initPlaybackSDK();
          this.getPlaybackState();
          this.fetchPlaylists();
        }).catch(() => {
          localStorage.removeItem('spotify_tokens');
        });
      }
    }
  },

  generateVerifier() {
    const array = new Uint8Array(64);
    crypto.getRandomValues(array);
    return btoa(String.fromCharCode(...array)).replace(/[^a-zA-Z0-9]/g, '').substring(0, 64);
  },

  async generateChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },

  async login() {
    const verifier = this.generateVerifier();
    localStorage.setItem('spotify_pkce_verifier', verifier);
    const challenge = await this.generateChallenge(verifier);

    const params = new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID,
      response_type: 'code',
      redirect_uri: SPOTIFY_REDIRECT_URI,
      scope: SPOTIFY_SCOPES,
      code_challenge_method: 'S256',
      code_challenge: challenge
    });

    window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
  },

  async exchangeCode(code) {
    const verifier = localStorage.getItem('spotify_pkce_verifier');
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
        client_id: SPOTIFY_CLIENT_ID,
        code_verifier: verifier
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error_description || data.error);

    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    this.saveTokens();
    localStorage.removeItem('spotify_pkce_verifier');
  },

  async refreshAccessToken() {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: SPOTIFY_CLIENT_ID
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error_description || data.error);

    this.accessToken = data.access_token;
    if (data.refresh_token) this.refreshToken = data.refresh_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    this.saveTokens();
  },

  saveTokens() {
    localStorage.setItem('spotify_tokens', JSON.stringify({
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt
    }));
  },

  async apiCall(method, endpoint, body = null) {
    if (Date.now() >= this.expiresAt - 60000) {
      await this.refreshAccessToken();
    }
    const options = {
      method,
      headers: { 'Authorization': `Bearer ${this.accessToken}` }
    };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const res = await fetch(`https://api.spotify.com/v1${endpoint}`, options);
    if (res.status === 204) return null;
    return res.json();
  },

  async fetchPlaylists() {
    try {
      const data = await this.apiCall('GET', '/me/playlists?limit=50');
      if (data && data.items) {
        this.playlists = data.items.map(p => ({
          id: p.id,
          name: p.name,
          uri: p.uri,
          tracks: p.tracks
        }));
        return this.playlists;
      }
    } catch (err) {
      console.error('Error fetching playlists:', err);
    }
    return [];
  },

  async playPlaylist(playlistUri) {
    try {
      await this.apiCall('PUT', '/me/player/play', {
        context_uri: playlistUri
      });
      this.isPlaying = true;
      await new Promise(r => setTimeout(r, 500));
      await this.getPlaybackState();
    } catch (err) {
      console.error('Error playing playlist:', err);
      showToast('Error al reproducir playlist');
    }
  },

  loadSDK() {
    return new Promise((resolve, reject) => {
      if (window.Spotify && window.Spotify.Player) {
        resolve();
        return;
      }

      window.onSpotifyWebPlaybackSDKReady = () => {
        resolve();
      };

      const script = document.createElement('script');
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      script.async = true;
      script.onerror = () => {
        reject(new Error('No se pudo cargar el SDK de Spotify. Verifica tu conexion.'));
      };
      document.head.appendChild(script);

      setTimeout(() => {
        if (!(window.Spotify && window.Spotify.Player)) {
          reject(new Error('SDK de Spotify no respondio'));
        }
      }, 15000);
    });
  },

  initPlaybackSDK() {
    if (this._playerInitialized) return;

    this.loadSDK().then(() => {
      this._playerInitialized = true;

      const player = new Spotify.Player({
        name: 'Walkman 3D',
        getOAuthToken: (cb) => { cb(this.accessToken); },
        volume: this.volume
      });

      player.addListener('ready', ({ device_id }) => {
        this.deviceId = device_id;
        this._playerReady = true;
        showToast('Audio listo en navegador');
      });

      player.addListener('not_ready', ({ device_id }) => {
        console.log('Device not ready:', device_id);
      });

      player.addListener('player_state_changed', (state) => {
        if (!state) return;
        this.isPlaying = !state.paused;
        if (state.track_window && state.track_window.current_track) {
          this.currentTrack = state.track_window.current_track;
          this.trackDuration = state.duration / 1000;
          this.trackPosition = state.position / 1000;
        }
      });

      player.addListener('authentication_error', (err) => {
        console.error('Auth error:', err);
        showToast('Error de autenticacion Spotify');
      });

      player.addListener('account_error', (err) => {
        console.error('Account error:', err);
        showToast('Se requiere Spotify Premium');
      });

      player.addListener('initialization_error', (err) => {
        console.error('Init error:', err);
      });

      player.connect();
      this._player = player;
    }).catch(err => {
      console.error('SDK load error:', err);
      showToast(err.message);
    });
  },

  async transferPlayback() {
    if (!this.deviceId) {
      console.log('No device ID yet, waiting...');
      await new Promise(r => setTimeout(r, 2000));
      if (!this.deviceId) {
        console.error('Device ID still null after wait');
        showToast('Error: player no conectado');
        return false;
      }
    }
    try {
      await this.apiCall('PUT', '/me/player', {
        device_ids: [this.deviceId],
        play: false
      });
      await new Promise(r => setTimeout(r, 1000));
      return true;
    } catch (err) {
      console.error('Transfer error:', err);
      showToast('Error transfiriendo audio');
      return false;
    }
  },

  async play() {
    await this.apiCall('PUT', '/me/player/play');
    this.isPlaying = true;
  },

  async pause() {
    await this.apiCall('PUT', '/me/player/pause');
    this.isPlaying = false;
  },

  async next() {
    await this.apiCall('POST', '/me/player/next');
    await this.waitForNewTrack();
  },

  async previous() {
    await this.apiCall('POST', '/me/player/previous');
    await this.waitForNewTrack();
  },

  async setVolume(volPercent) {
    this.volume = volPercent / 100;
    if (this._player) {
      this._player.setVolume(volPercent / 100);
    }
    if (this.deviceId) {
      try {
        await this.apiCall('PUT', `/me/player/volume?volume_percent=${Math.round(volPercent)}`);
      } catch (e) {}
    }
  },

  async getPlaybackState() {
    try {
      const pState = await this.apiCall('GET', '/me/player');
      if (pState) {
        if (pState.item) {
          this.currentTrack = pState.item;
          this.trackDuration = (pState.item.duration_ms || 0) / 1000;
        }
        if (typeof pState.progress_ms === 'number') {
          this.trackPosition = pState.progress_ms / 1000;
        }
        this.isPlaying = !!pState.is_playing;

        if (pState.context && pState.context.uri) {
          const matchedPl = this.playlists.find(p => p.uri === pState.context.uri);
          if (matchedPl) {
            state.spotifyPlaylistName = matchedPl.name;
          }
        }
      }
      return pState;
    } catch (e) {
      return null;
    }
  },

  waitForNewTrack() {
    return new Promise(resolve => {
      const check = async () => {
        const pState = await this.getPlaybackState();
        if (pState && pState.item) resolve(pState);
        else setTimeout(check, 200);
      };
      setTimeout(check, 300);
    });
  },

  onConnected() {
    this.isConnected = true;
    this.updateUI();
    this.initPlaybackSDK();
    this.getPlaybackState();
    this.fetchPlaylists();
    showToast('Spotify conectado correctamente');
  },

  updateUI() {
    const btn = document.getElementById('btn-spotify-connect');
    const text = document.getElementById('spotify-connect-text');
    if (btn && text) {
      if (this.isConnected) {
        btn.classList.add('connected');
        text.textContent = 'Spotify Conectado';
      } else {
        btn.classList.remove('connected');
        text.textContent = 'Conectar Spotify';
      }
    }
  },

  logout() {
    this.isConnected = false;
    this.accessToken = null;
    this.refreshToken = null;
    this.deviceId = null;
    this.currentTrack = null;
    this.playlists = [];
    this.playlistIndex = 0;
    if (this._player) {
      this._player.disconnect();
      this._player = null;
      this._playerInitialized = false;
    }
    localStorage.removeItem('spotify_tokens');
    this.updateUI();
    showToast('Spotify desconectado');
  }
};

// Connect button
document.getElementById('btn-spotify-connect')?.addEventListener('click', () => {
  if (SpotifyAuth.isConnected) {
    SpotifyAuth.logout();
  } else {
    SpotifyAuth.login();
  }
});

// Initialize Spotify on load
SpotifyAuth.init();

// ==========================================
// 2. STATE & MUSIC PLAYLIST ENGINE
// ==========================================
const MUSIC_LIBRARY = [
  {
    genre: "SYNTHWAVE",
    color: "#00f2fe",
    tracks: [
      { title: "NEON HIGHWAY", artist: "CyberPulse 1984", bpm: 120, synthType: "sawtooth", baseFreq: 110 },
      { title: "NIGHTCALL HORIZONS", artist: "Retro Wave X", bpm: 115, synthType: "square", baseFreq: 130 },
      { title: "CYBERPUNK CITY", artist: "Midnight Synth", bpm: 124, synthType: "triangle", baseFreq: 140 }
    ]
  },
  {
    genre: "LO-FI CHILL",
    color: "#ffb703",
    tracks: [
      { title: "RAINY COFFEE SHOP", artist: "Chill Hop Beats", bpm: 75, synthType: "sine", baseFreq: 174 },
      { title: "MIDNIGHT STUDY", artist: "Lo-Fi Dreamer", bpm: 80, synthType: "triangle", baseFreq: 196 },
      { title: "NOSTALGIA TAPE", artist: "Vinyl Breeze", bpm: 72, synthType: "sine", baseFreq: 220 }
    ]
  },
  {
    genre: "CYBER ROCK",
    color: "#ff007f",
    tracks: [
      { title: "OVERDRIVE 2077", artist: "Heavy Distortion", bpm: 138, synthType: "sawtooth", baseFreq: 98 },
      { title: "QUANTUM SHRED", artist: "Byte Smasher", bpm: 145, synthType: "square", baseFreq: 123 },
      { title: "NEON THUNDER", artist: "Electric Titans", bpm: 140, synthType: "sawtooth", baseFreq: 110 }
    ]
  },
  {
    genre: "SYNTH POP",
    color: "#00ff88",
    tracks: [
      { title: "STARLIGHT DISCO", artist: "Funk Wave Allstars", bpm: 125, synthType: "square", baseFreq: 150 },
      { title: "GLITCH ROMANCE", artist: "Electro Sweet", bpm: 128, synthType: "triangle", baseFreq: 165 },
      { title: "FUTURE DANCE", artist: "Pixel Party", bpm: 130, synthType: "sawtooth", baseFreq: 175 }
    ]
  }
];

let state = {
  isPowerOn: true,
  isPlaying: false,
  genreIndex: 0,
  trackIndex: 0,
  volume: 0.7,
  trackTime: 0,
  duration: 180,
  lastAtrasClickTime: 0,
  spotifyPlaylistName: '',
  playlistIndex: 0
};

// Button labels for hover tooltips
const BUTTON_CONFIG = {
  power: { name: '🔴 POWER', color: '#ff2a4b' },
  modo: { name: '🟡 MODO', color: '#ffb703' },
  menos: { name: '🔵 VOL -', color: '#00a8ff' },
  play: { name: '🟢 PLAY / PAUSE', color: '#00ff88' },
  mas: { name: '🔵 VOL +', color: '#00f2fe' },
  atras: { name: '🟣 ATRÁS (1x Reinicia, 2x Anterior)', color: '#9b51e0' },
  adelante: { name: '🟣 ADELANTE (Siguiente)', color: '#ff007f' }
};

// ==========================================
// 2. WEB AUDIO API SYNTHESIZER
// ==========================================
class WebAudioPlayer {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
    this.isPlaying = false;
    this.timerId = null;
    this.step = 0;
    this.freqData = new Uint8Array(32);
  }

  init() {
    if (this.ctx) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(state.volume, this.ctx.currentTime);
      
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 64;
      
      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    } catch (err) {
      console.error("Error AudioContext:", err);
    }
  }

  play() {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    this.isPlaying = true;
    if (!this.timerId) {
      this.scheduleLoop();
    }
  }

  pause() {
    this.isPlaying = false;
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  setVolume(vol) {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.linearRampToValueAtTime(vol, this.ctx.currentTime + 0.05);
    }
  }

  playClickSound() {
    this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(900, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(250, this.ctx.currentTime + 0.06);
    
    gain.gain.setValueAtTime(0.35 * state.volume, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.06);
    
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.06);
  }

  playModeChime() {
    this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const now = this.ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + i * 0.05);
      gain.gain.setValueAtTime(0.25 * state.volume, now + i * 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.05 + 0.18);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now + i * 0.05);
      osc.stop(now + i * 0.05 + 0.18);
    });
  }

  scheduleLoop() {
    const currentGenre = MUSIC_LIBRARY[state.genreIndex];
    const currentTrack = currentGenre.tracks[state.trackIndex];
    const intervalMs = (60 / currentTrack.bpm / 4) * 1000;

    this.timerId = setInterval(() => {
      if (!this.isPlaying) return;
      this.playSynthStep(currentTrack);
      this.step = (this.step + 1) % 16;
      state.trackTime = (state.trackTime + (intervalMs / 1000)) % state.duration;
    }, intervalMs);
  }

  playSynthStep(track) {
    if (!this.ctx || !this.isPlaying) return;
    const t = this.ctx.currentTime;
    const baseF = track.baseFreq;

    if (this.step % 4 === 0) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = track.synthType;
      osc.frequency.setValueAtTime(baseF * 0.5, t);
      gain.gain.setValueAtTime(0.35 * state.volume, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + 0.22);
    }

    if (this.step % 2 === 0) {
      const scale = [1, 1.25, 1.333, 1.5, 1.875, 2];
      const noteOffset = scale[this.step % scale.length];
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(baseF * noteOffset, t);
      gain.gain.setValueAtTime(0.2 * state.volume, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + 0.14);
    }
  }

  getFrequencyData() {
    if (this.analyser) {
      this.analyser.getByteFrequencyData(this.freqData);
    }
    return this.freqData;
  }
}

const audioEngine = new WebAudioPlayer();

// ==========================================
// 3. DYNAMIC SCREEN CANVAS TEXTURE
// ==========================================
const screenCanvas = document.getElementById('screen-canvas');
const screenCtx = screenCanvas.getContext('2d');
const screenTexture = new THREE.CanvasTexture(screenCanvas);
screenTexture.minFilter = THREE.LinearFilter;
screenTexture.magFilter = THREE.LinearFilter;
screenTexture.wrapS = THREE.ClampToEdgeWrapping;
screenTexture.wrapT = THREE.ClampToEdgeWrapping;

function drawRoundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function truncateCanvasText(ctx, text, maxWidth) {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 0 && ctx.measureText(truncated + '...').width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + '...';
}

function drawCleanDisplay({ playlistName, songTitle, progressRatio, isOff }) {
  const w = screenCanvas.width;
  const h = screenCanvas.height;

  if (isOff) {
    screenCtx.fillStyle = '#05070e';
    screenCtx.fillRect(0, 0, w, h);

    const padX = 70;
    screenCtx.textAlign = 'left';
    screenCtx.textBaseline = 'alphabetic';

    screenCtx.fillStyle = '#1e293b';
    screenCtx.font = '500 32px "Outfit", sans-serif';
    screenCtx.fillText('WALKMAN STEREO', padX, 155);

    screenCtx.fillStyle = '#334155';
    screenCtx.font = 'bold 58px "Outfit", sans-serif';
    screenCtx.fillText('APAGADO', padX, 250);

    const barX = padX;
    const barY = 325;
    const barW = w - padX * 2;
    const barH = 24;
    const radius = barH / 2;

    screenCtx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    screenCtx.lineWidth = 3;
    drawRoundedRect(screenCtx, barX, barY, barW, barH, radius);
    screenCtx.stroke();
    return;
  }

  // 1. Dark Navy OLED Background
  screenCtx.fillStyle = '#0e1826';
  screenCtx.fillRect(0, 0, w, h);

  const padX = 70;
  const maxTextW = w - padX * 2;
  screenCtx.textAlign = 'left';
  screenCtx.textBaseline = 'alphabetic';

  // 2. Playlist Name (Top Line - Subtitle)
  screenCtx.fillStyle = '#94a3b8';
  screenCtx.font = '500 32px "Outfit", sans-serif';
  const cleanPl = truncateCanvasText(screenCtx, playlistName || 'Nombre de playlist', maxTextW);
  screenCtx.fillText(cleanPl, padX, 155);

  // 3. Song Name (Middle Line - Large Bold Title)
  screenCtx.fillStyle = '#ffffff';
  screenCtx.font = 'bold 58px "Outfit", sans-serif';
  const cleanTitle = truncateCanvasText(screenCtx, songTitle || 'Nombre de canción', maxTextW);
  screenCtx.fillText(cleanTitle, padX, 250);

  // 4. Progress Bar Slider (Bottom Line - Capsule Slider with Knob)
  const barX = padX;
  const barY = 325;
  const barW = w - padX * 2;
  const barH = 24;
  const radius = barH / 2;
  const clampedProgress = Math.min(Math.max(progressRatio || 0, 0), 1);

  // Outer Capsule Track Outline
  screenCtx.fillStyle = 'rgba(255, 255, 255, 0.06)';
  screenCtx.strokeStyle = '#ffffff';
  screenCtx.lineWidth = 3.5;
  drawRoundedRect(screenCtx, barX, barY, barW, barH, radius);
  screenCtx.fill();
  screenCtx.stroke();

  // Solid White Progress Fill
  if (clampedProgress > 0) {
    const fillW = Math.max(radius * 2, barW * clampedProgress);
    screenCtx.fillStyle = '#ffffff';
    drawRoundedRect(screenCtx, barX, barY, fillW, barH, radius);
    screenCtx.fill();
  }

  // White Knob / Slider Handle
  const knobRadius = 15;
  const knobX = Math.min(barX + barW - radius, Math.max(barX + radius, barX + barW * clampedProgress));
  const knobY = barY + barH / 2;

  screenCtx.fillStyle = '#ffffff';
  screenCtx.beginPath();
  screenCtx.arc(knobX, knobY, knobRadius, 0, Math.PI * 2);
  screenCtx.fill();

  screenCtx.strokeStyle = 'rgba(14, 24, 38, 0.35)';
  screenCtx.lineWidth = 2;
  screenCtx.stroke();
}

function updateScreenCanvas() {
  if (!state.isPowerOn) {
    drawCleanDisplay({ isOff: true });
    screenTexture.needsUpdate = true;
    return;
  }

  if (SpotifyAuth.isConnected) {
    const track = SpotifyAuth.currentTrack;
    const plName = state.spotifyPlaylistName || (track?.album?.name ? `Álbum: ${track.album.name}` : 'Mi Playlist');
    const songTitle = track ? track.name : 'Presiona PLAY';
    const position = SpotifyAuth.trackPosition || 0;
    const duration = SpotifyAuth.trackDuration || 0;
    const progressRatio = duration > 0 ? (position / duration) : 0;

    drawCleanDisplay({
      playlistName: plName,
      songTitle: songTitle,
      progressRatio: progressRatio,
      isOff: false
    });
    screenTexture.needsUpdate = true;
    return;
  }

  // Built-in Synthesizer Radio Mode
  const currentGenre = MUSIC_LIBRARY[state.genreIndex];
  const currentTrack = currentGenre.tracks[state.trackIndex];
  const duration = state.duration || 180;
  const position = state.trackTime || 0;
  const progressRatio = duration > 0 ? (position / duration) : 0;

  drawCleanDisplay({
    playlistName: `Playlist • ${currentGenre.genre}`,
    songTitle: `${currentTrack.title} - ${currentTrack.artist}`,
    progressRatio: progressRatio,
    isOff: false
  });
  screenTexture.needsUpdate = true;
}

// ==========================================
// 4. THREE.JS SCENE SETUP
// ==========================================
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
const creamBg = 0xf5f3ee;
scene.background = new THREE.Color(creamBg);
scene.fog = new THREE.FogExp2(creamBg, 0.02);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
const initialCamPos = new THREE.Vector3(0, 0.5, 4.2);
camera.position.copy(initialCamPos);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI / 2 + 0.05;
controls.minDistance = 1;
controls.maxDistance = 15;
controls.target.set(0, 0, 0);

// Warm Studio Lighting tailored for light cream environment
const ambientLight = new THREE.AmbientLight(0xffffff, 2.0);
scene.add(ambientLight);

const dirLight1 = new THREE.DirectionalLight(0xfffdf7, 2.2);
dirLight1.position.set(6, 12, 8);
dirLight1.castShadow = true;
dirLight1.shadow.mapSize.width = 2048;
dirLight1.shadow.mapSize.height = 2048;
dirLight1.shadow.bias = -0.0001;
scene.add(dirLight1);

const dirLight2 = new THREE.DirectionalLight(0xe8f0fe, 1.0);
dirLight2.position.set(-8, 6, 6);
scene.add(dirLight2);

const dirLight3 = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight3.position.set(0, -4, -6);
scene.add(dirLight3);

// Studio Floor Shadow Receiver
const floorGeo = new THREE.PlaneGeometry(50, 50);
const floorMat = new THREE.ShadowMaterial({ opacity: 0.15 });
const floorPlane = new THREE.Mesh(floorGeo, floorMat);
floorPlane.rotation.x = -Math.PI / 2;
floorPlane.position.y = -1.2;
floorPlane.receiveShadow = true;
scene.add(floorPlane);

// Subtle Studio Floor Grid
const gridHelper = new THREE.GridHelper(40, 40, 0xd5d0c2, 0xe8e4d8);
gridHelper.position.y = -1.199;
scene.add(gridHelper);

// ==========================================
// 5. FBX MODEL LOADER & COLOR PALETTE
// ==========================================
const walkmanGroup = new THREE.Group();
scene.add(walkmanGroup);

const MASTER_FBX_FILE = 'adelante_Collection/cuerpo_Collection.fbx';

const loadedMeshes = {};
const interactableObjects = [];
const buttonPhysicsData = {};
const activeButtonAnimations = {};

const screenMaterial = new THREE.MeshStandardMaterial({
  map: screenTexture,
  emissiveMap: screenTexture,
  emissive: new THREE.Color(0xffffff),
  emissiveIntensity: 1.2,
  roughness: 0.1,
  metalness: 0.0,
  side: THREE.DoubleSide
});

// Helper to map Blender object name to part identifier
function identifyPartName(rawName) {
  if (!rawName) return null;
  const name = rawName.trim();

  // Strict regex to prevent collisions like 'Display' matching 'play' or 'master' matching 'mas'
  if (/(?:^|[_.\-\s])power(?:[_.\-\s\d]|$)/i.test(name)) return 'power';
  if (/(?:^|[_.\-\s])modo(?:[_.\-\s\d]|$)/i.test(name)) return 'modo';
  if (/(?:^|[_.\-\s])play(?:[_.\-\s\d]|$)/i.test(name) && !/display/i.test(name)) return 'play';
  if (/(?:^|[_.\-\s])adelante(?:[_.\-\s\d]|$)/i.test(name)) return 'adelante';
  if (/(?:^|[_.\-\s])atras(?:[_.\-\s\d]|$)/i.test(name)) return 'atras';
  if (/(?:^|[_.\-\s])menos(?:[_.\-\s\d]|$)/i.test(name)) return 'menos';
  if (/(?:^|[_.\-\s])mas(?:[_.\-\s\d]|$)/i.test(name) && !/master|material/i.test(name)) return 'mas';
  if (/(?:^|[_.\-\s])pantalla(?:[_.\-\s\d]|$)/i.test(name)) return 'pantalla';
  if (/(?:^|[_.\-\s])cuerpo(?:[_.\-\s\d]|$)/i.test(name)) return 'cuerpo';

  return null;
}

// Comprehensive Triplanar / Box-Face UV Generator for 3D Screen Meshes
function ensurePlanarUVs(geometry) {
  geometry.computeBoundingBox();
  geometry.computeVertexNormals();
  const bbox = geometry.boundingBox;
  const pos = geometry.attributes.position;
  const norm = geometry.attributes.normal;
  if (!pos) return;

  const dx = Math.abs(bbox.max.x - bbox.min.x) || 1e-4;
  const dy = Math.abs(bbox.max.y - bbox.min.y) || 1e-4;
  const dz = Math.abs(bbox.max.z - bbox.min.z) || 1e-4;

  const uvs = new Float32Array(pos.count * 2);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);

    let nx = 0, ny = 0, nz = 1;
    if (norm) {
      nx = norm.getX(i);
      ny = norm.getY(i);
      nz = norm.getZ(i);
    }

    const absX = Math.abs(nx);
    const absY = Math.abs(ny);
    const absZ = Math.abs(nz);

    let rawU, rawV;

    if (absZ >= absX && absZ >= absY) {
      // XY face (facing Z)
      rawU = (x - bbox.min.x) / dx;
      rawV = (y - bbox.min.y) / dy;
      if (nz < 0) rawU = 1 - rawU;
    } else if (absY >= absX && absY >= absZ) {
      // XZ face (facing Y)
      rawU = (x - bbox.min.x) / dx;
      rawV = (z - bbox.min.z) / dz;
      if (ny < 0) rawU = 1 - rawU;
    } else {
      // YZ face (facing X)
      rawU = (z - bbox.min.z) / dz;
      rawV = (y - bbox.min.y) / dy;
      if (nx < 0) rawU = 1 - rawU;
    }

    // Rotate 180 degrees (right-side up in portrait orientation)
    const u = rawV;
    const v = 1 - rawU;

    uvs[i * 2] = Math.max(0, Math.min(1, u));
    uvs[i * 2 + 1] = Math.max(0, Math.min(1, v));
  }

  // Force overwrite UV attribute so Blender's broken UVs don't override the screen texture
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.attributes.uv.needsUpdate = true;
}

const fbxLoader = new FBXLoader();
const progressBarEl = document.getElementById('progress-bar');
const loaderOverlayEl = document.getElementById('loader');

fbxLoader.load(
  MASTER_FBX_FILE,
  (fbx) => {
    // Remove default Blender lights and cameras
    const toRemove = [];
    fbx.traverse((child) => {
      if (child.isCamera || child.isLight || child.name === 'Camera' || child.name === 'Light') {
        toRemove.push(child);
      }
    });
    toRemove.forEach((obj) => {
      if (obj.parent) obj.parent.remove(obj);
    });

    // Identify and setup each distinct component mesh with its original Blender materials
    const allMeshNames = [];
    fbx.traverse((child) => {
      if (child.isMesh) {
        allMeshNames.push(child.name);
      }
    });
    console.log('FBX mesh names:', allMeshNames);

    fbx.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;

        const partName = identifyPartName(child.name) || (child.parent ? identifyPartName(child.parent.name) : null);
        if (partName) {
          child.userData.partName = partName;
          loadedMeshes[partName] = child;

          if (partName === 'pantalla') {
            ensurePlanarUVs(child.geometry);
            child.material = screenMaterial;
          } else {
            // Keep original material and colors exactly as created in Blender
            if (Array.isArray(child.material)) {
              child.material.forEach((m) => {
                m.side = THREE.DoubleSide;
                if (m.emissive) child.userData.origEmissive = m.emissive.clone();
              });
            } else if (child.material) {
              child.material.side = THREE.DoubleSide;
              if (child.material.emissive) child.userData.origEmissive = child.material.emissive.clone();
            }
          }

          if (partName !== 'cuerpo' && partName !== 'pantalla') {
            interactableObjects.push(child);
          }
        }
      }
    });

    walkmanGroup.add(fbx);

    if (progressBarEl) progressBarEl.style.width = '100%';
    onAllModelsLoaded();
  },
  (xhr) => {
    if (xhr.total > 0) {
      const percent = Math.round((xhr.loaded / xhr.total) * 100);
      if (progressBarEl) progressBarEl.style.width = `${percent}%`;
    }
  },
  (err) => console.error(`Error loading master FBX:`, err)
);

function initButtonPhysics() {
  const cuerpoMesh = loadedMeshes['cuerpo'];
  if (!cuerpoMesh) return;

  walkmanGroup.updateMatrixWorld(true);

  // Compute bounding box and center of cuerpo in local space
  cuerpoMesh.geometry.computeBoundingBox();
  const cuerpoBox = new THREE.Box3().setFromObject(cuerpoMesh);
  const cuerpoCenter = cuerpoBox.getCenter(new THREE.Vector3());

  const buttonNames = ['power', 'modo', 'mas', 'menos', 'play', 'adelante', 'atras'];

  buttonNames.forEach((name) => {
    const btnMesh = loadedMeshes[name];
    if (!btnMesh) return;

    btnMesh.geometry.computeBoundingBox();
    const btnBox = new THREE.Box3().setFromObject(btnMesh);
    const btnCenter = btnBox.getCenter(new THREE.Vector3());
    const btnSize = btnBox.getSize(new THREE.Vector3());

    // Inward vector pointing from button center towards the interior center of cuerpo
    const toCuerpo = new THREE.Vector3().subVectors(cuerpoCenter, btnCenter);

    const absX = Math.abs(toCuerpo.x);
    const absY = Math.abs(toCuerpo.y);
    const absZ = Math.abs(toCuerpo.z);

    let pushDir = new THREE.Vector3();

    // Determine primary face normal for the cleanest inward press
    if (absY >= absX && absY >= absZ) {
      pushDir.set(0, Math.sign(toCuerpo.y) || -1, 0);
    } else if (absZ >= absX && absZ >= absY) {
      pushDir.set(0, 0, Math.sign(toCuerpo.z) || -1);
    } else {
      pushDir.set(Math.sign(toCuerpo.x) || -1, 0, 0);
    }

    // Depth proportional to button size for noticeable tactile motion
    const maxDim = Math.max(btnSize.x, btnSize.y, btnSize.z);
    const depth = Math.max(0.08, Math.min(0.25, maxDim * 0.45));

    buttonPhysicsData[name] = {
      mesh: btnMesh,
      originalPos: btnMesh.position.clone(),
      pushDir: pushDir,
      depth: depth
    };
  });
}

function onAllModelsLoaded() {
  const box = new THREE.Box3().setFromObject(walkmanGroup);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);

  if (maxDim > 0) {
    const targetScale = 2.5 / maxDim;
    walkmanGroup.scale.set(targetScale, targetScale, targetScale);
  }

  const scaledBox = new THREE.Box3().setFromObject(walkmanGroup);
  const scaledCenter = scaledBox.getCenter(new THREE.Vector3());
  walkmanGroup.position.sub(scaledCenter);

  // Update transformation matrices
  walkmanGroup.updateMatrixWorld(true);
  scene.updateMatrixWorld(true);

  camera.position.set(0, 0.5, 4.2);
  controls.target.set(0, 0, 0);
  controls.update();

  // Initialize inward physics vectors for each interactive button
  initButtonPhysics();

  const powerLed = document.getElementById('power-led');
  const powerText = document.getElementById('power-text');
  if (state.isPowerOn) {
    if (powerLed) powerLed.classList.add('active');
    if (powerText) powerText.textContent = 'ENCENDIDO';
    screenMaterial.emissiveIntensity = 1.2;
  }

  updateScreenCanvas();

  if (loaderOverlayEl) loaderOverlayEl.classList.add('hidden');
  showToast(" Walkman 3D Listo.");
}

// ==========================================
// 6. RAYCASTING & DIRECT 3D BUTTON CLICKS
// ==========================================
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hoveredMesh = null;
let pointerDownPos = { x: 0, y: 0, time: 0 };

const tooltipEl = document.getElementById('button-tooltip');

// Helper to get partName from any intersected object or its ancestors
function getHitPartName(object) {
  let curr = object;
  while (curr && curr !== walkmanGroup && curr !== scene) {
    if (curr.userData && curr.userData.partName) {
      return curr.userData.partName;
    }
    curr = curr.parent;
  }
  return null;
}

window.addEventListener('mousemove', (event) => {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  // Move tooltip near cursor
  if (tooltipEl) {
    tooltipEl.style.left = `${event.clientX}px`;
    tooltipEl.style.top = `${event.clientY}px`;
  }

  walkmanGroup.updateMatrixWorld(true);
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(interactableObjects, true);

  if (intersects.length > 0) {
    const hitObj = intersects[0].object;
    const partName = getHitPartName(hitObj);

    if (partName && partName !== 'cuerpo' && partName !== 'pantalla') {
      document.body.style.cursor = 'pointer';
      
      if (hoveredMesh !== hitObj) {
        resetHover();
        hoveredMesh = hitObj;
        if (hitObj.material && hitObj.material.emissive) {
          hitObj.material.emissive.setHex(0x00f2fe);
          hitObj.material.emissiveIntensity = 0.6;
        }
      }

      // Show floating 3D tooltip
      const btnInfo = BUTTON_CONFIG[partName];
      if (btnInfo && tooltipEl) {
        tooltipEl.textContent = btnInfo.name;
        tooltipEl.style.borderColor = btnInfo.color;
        tooltipEl.classList.add('show');
      }
    } else {
      document.body.style.cursor = 'default';
      resetHover();
    }
  } else {
    document.body.style.cursor = 'default';
    resetHover();
  }
});

function resetHover() {
  if (hoveredMesh) {
    if (hoveredMesh.material && hoveredMesh.material.emissive) {
      if (hoveredMesh.userData.origEmissive) {
        hoveredMesh.material.emissive.copy(hoveredMesh.userData.origEmissive);
      } else {
        hoveredMesh.material.emissive.setHex(0x000000);
      }
      hoveredMesh.material.emissiveIntensity = 0;
    }
    hoveredMesh = null;
  }
  if (tooltipEl) tooltipEl.classList.remove('show');
}

window.addEventListener('pointerdown', (event) => {
  pointerDownPos = {
    x: event.clientX,
    y: event.clientY,
    time: performance.now()
  };
});

window.addEventListener('pointerup', (event) => {
  // Ignore clicks on UI header banner or instruction card
  if (event.target.closest('.app-header') || event.target.closest('.instruction-card')) return;

  // Prevent drag-rotation from triggering a button press
  const dx = event.clientX - pointerDownPos.x;
  const dy = event.clientY - pointerDownPos.y;
  const dist = Math.hypot(dx, dy);
  if (dist > 8) return;

  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  walkmanGroup.updateMatrixWorld(true);
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(interactableObjects, true);

  if (intersects.length > 0) {
    const partName = getHitPartName(intersects[0].object);
    if (partName && partName !== 'cuerpo' && partName !== 'pantalla') {
      animateButtonPress(partName);
      handleButtonAction(partName);
    }
  }
});

function animateButtonPress(partName) {
  const cfg = buttonPhysicsData[partName];
  if (!cfg) return;

  // Trigger smooth tactile physics animation
  activeButtonAnimations[partName] = {
    startTime: performance.now(),
    duration: 220
  };

  // Visual pulse on material
  cfg.mesh.traverse((child) => {
    if (child.isMesh && child.material && child.material.emissive) {
      const origEmissive = child.userData.origEmissive ? child.userData.origEmissive.clone() : new THREE.Color(0x000000);
      child.material.emissive.setHex(0xffffff);
      child.material.emissiveIntensity = 0.6;
      setTimeout(() => {
        child.material.emissive.copy(origEmissive);
        child.material.emissiveIntensity = 0;
      }, 120);
    }
  });
}

function updateButtonAnimations() {
  const now = performance.now();
  for (const [btnName, anim] of Object.entries(activeButtonAnimations)) {
    const cfg = buttonPhysicsData[btnName];
    if (!cfg) continue;

    const elapsed = (now - anim.startTime) / anim.duration;
    if (elapsed < 1.0) {
      // Tactile physical curve:
      // Fast inward push into the cuerpo (0% to 35% time), smooth spring release back out (35% to 100%)
      let factor = 0;
      if (elapsed < 0.35) {
        const t = elapsed / 0.35;
        factor = Math.sin(t * (Math.PI / 2));
      } else {
        const t = (elapsed - 0.35) / 0.65;
        factor = Math.cos(t * (Math.PI / 2)) * (1 - 0.2 * Math.sin(t * Math.PI));
      }
      factor = Math.max(0, Math.min(1.2, factor));

      // Move momentarily more "inwards" towards cuerpo
      cfg.mesh.position.copy(cfg.originalPos).addScaledVector(cfg.pushDir, cfg.depth * factor);
    } else {
      // Return to exact original resting position
      cfg.mesh.position.copy(cfg.originalPos);
      delete activeButtonAnimations[btnName];
    }
  }
}

// ==========================================
// 7. BUTTON CONTROL ACTION HANDLERS
// ==========================================
function handleButtonAction(actionName) {
  if (SpotifyAuth.isConnected) {
    handleSpotifyButtonAction(actionName);
    return;
  }

  switch (actionName) {
    case 'power':
      togglePower();
      break;
    case 'modo':
      changeMode();
      break;
    case 'mas':
      changeVolume(0.1);
      break;
    case 'menos':
      changeVolume(-0.1);
      break;
    case 'play':
      togglePlay();
      break;
    case 'adelante':
      nextTrack();
      break;
    case 'atras':
      handleAtrasButton();
      break;
    default:
      console.warn("Boton no reconocido:", actionName);
      break;
  }
}

function handleSpotifyButtonAction(actionName) {
  audioEngine.playClickSound();

  switch (actionName) {
    case 'power':
      if (!state.isPowerOn) {
        state.isPowerOn = true;
        const powerLed = document.getElementById('power-led');
        const powerText = document.getElementById('power-text');
        if (powerLed) powerLed.classList.add('active');
        if (powerText) powerText.textContent = 'ENCENDIDO';
        screenMaterial.emissiveIntensity = 1.2;
        updateScreenCanvas();

        const startSpotify = async () => {
          showToast('Conectando con Spotify...');
          await SpotifyAuth.fetchPlaylists();
          if (SpotifyAuth.playlists.length > 0) {
            const pl = SpotifyAuth.playlists[0];
            state.spotifyPlaylistName = pl.name;
            state.playlistIndex = 0;
          }

          if (!SpotifyAuth._playerReady) {
            showToast('Esperando player de Spotify...');
            let tries = 0;
            while (!SpotifyAuth._playerReady && tries < 20) {
              await new Promise(r => setTimeout(r, 500));
              tries++;
            }
            if (!SpotifyAuth._playerReady) {
              showToast('Error: player no conectado. Revisa la consola (F12)');
              return;
            }
          }

          showToast('Transfiriendo audio...');
          const ok = await SpotifyAuth.transferPlayback();
          if (!ok) return;

          if (SpotifyAuth.playlists.length > 0) {
            const pl = SpotifyAuth.playlists[state.playlistIndex];
            await SpotifyAuth.playPlaylist(pl.uri);
            showToast(`Reproduciendo: ${pl.name}`);
          } else {
            showToast('No se encontraron playlists');
          }
          updateScreenCanvas();
        };

        startSpotify().catch(err => {
          console.error('Spotify power error:', err);
          showToast('Error al iniciar Spotify');
        });
      } else {
        state.isPowerOn = false;
        const powerLed = document.getElementById('power-led');
        const powerText = document.getElementById('power-text');
        if (powerLed) powerLed.classList.remove('active');
        if (powerText) powerText.textContent = 'APAGADO';
        screenMaterial.emissiveIntensity = 0.1;
        SpotifyAuth.pause();
        showToast('Walkman Apagado');
        updateScreenCanvas();
      }
      break;

    case 'play':
      if (!state.isPowerOn) {
        handleSpotifyButtonAction('power');
        return;
      }
      if (SpotifyAuth.isPlaying) {
        SpotifyAuth.pause();
        showToast('Pausado');
      } else {
        SpotifyAuth.play();
        showToast('Reproduciendo');
      }
      setTimeout(updateScreenCanvas, 200);
      break;

    case 'modo':
      if (!state.isPowerOn) {
        handleSpotifyButtonAction('power');
        return;
      }
      if (SpotifyAuth.playlists.length === 0) {
        showToast('No hay playlists cargadas');
        return;
      }
      state.playlistIndex = (state.playlistIndex + 1) % SpotifyAuth.playlists.length;
      const nextPl = SpotifyAuth.playlists[state.playlistIndex];
      state.spotifyPlaylistName = nextPl.name;
      SpotifyAuth.playPlaylist(nextPl.uri);
      audioEngine.playModeChime();
      showToast(`Playlist: ${nextPl.name}`);
      setTimeout(updateScreenCanvas, 500);
      break;

    case 'adelante':
      if (!state.isPowerOn) {
        handleSpotifyButtonAction('power');
        return;
      }
      SpotifyAuth.next();
      showToast('Siguiente cancion');
      setTimeout(updateScreenCanvas, 500);
      break;

    case 'atras':
      if (!state.isPowerOn) {
        handleSpotifyButtonAction('power');
        return;
      }
      SpotifyAuth.previous();
      showToast('Cancion anterior');
      setTimeout(updateScreenCanvas, 500);
      break;

    case 'mas':
      if (!state.isPowerOn) {
        handleSpotifyButtonAction('power');
        return;
      }
      state.volume = Math.min(1, Math.round((state.volume + 0.1) * 10) / 10);
      SpotifyAuth.setVolume(state.volume * 100);
      showToast(`VOL +: ${Math.round(state.volume * 100)}%`);
      updateScreenCanvas();
      break;

    case 'menos':
      if (!state.isPowerOn) {
        handleSpotifyButtonAction('power');
        return;
      }
      state.volume = Math.max(0, Math.round((state.volume - 0.1) * 10) / 10);
      SpotifyAuth.setVolume(state.volume * 100);
      showToast(`VOL -: ${Math.round(state.volume * 100)}%`);
      updateScreenCanvas();
      break;
  }
}

function powerOnSilent() {
  state.isPowerOn = true;
  state.isPlaying = true;
  const powerLed = document.getElementById('power-led');
  const powerText = document.getElementById('power-text');
  if (powerLed) powerLed.classList.add('active');
  if (powerText) powerText.textContent = 'ENCENDIDO';
  screenMaterial.emissiveIntensity = 1.2;
  audioEngine.play();
}

function togglePower() {
  audioEngine.playClickSound();
  state.isPowerOn = !state.isPowerOn;

  const powerLed = document.getElementById('power-led');
  const powerText = document.getElementById('power-text');

  if (state.isPowerOn) {
    if (powerLed) powerLed.classList.add('active');
    if (powerText) powerText.textContent = 'ENCENDIDO';
    screenMaterial.emissiveIntensity = 1.2;
    
    state.isPlaying = true;
    audioEngine.play();
    showToast("⚡ POWER ON - Reproduciendo");
  } else {
    if (powerLed) powerLed.classList.remove('active');
    if (powerText) powerText.textContent = 'APAGADO';
    screenMaterial.emissiveIntensity = 0.1;

    state.isPlaying = false;
    audioEngine.pause();
    showToast("🔌 POWER OFF");
  }
  updateScreenCanvas();
}

function changeMode() {
  if (!state.isPowerOn) {
    powerOnSilent();
  }
  audioEngine.playModeChime();
  state.genreIndex = (state.genreIndex + 1) % MUSIC_LIBRARY.length;
  state.trackIndex = 0;
  state.trackTime = 0;

  const genre = MUSIC_LIBRARY[state.genreIndex];
  showToast(`📻 MODO: ${genre.genre}`);

  if (state.isPlaying) {
    audioEngine.pause();
    audioEngine.play();
  }
  updateScreenCanvas();
}

function changeVolume(delta) {
  if (!state.isPowerOn && delta > 0) {
    powerOnSilent();
  }
  audioEngine.playClickSound();
  state.volume = Math.max(0, Math.min(1, Math.round((state.volume + delta) * 10) / 10));
  audioEngine.setVolume(state.volume);

  const percent = Math.round(state.volume * 100);
  const actionLabel = delta > 0 ? "VOL +" : "VOL -";
  showToast(`🔊 ${actionLabel}: ${percent}%`);
  updateScreenCanvas();
}

function togglePlay() {
  audioEngine.playClickSound();
  if (!state.isPowerOn) {
    togglePower();
    return;
  }

  state.isPlaying = !state.isPlaying;

  if (state.isPlaying) {
    audioEngine.play();
    showToast("▶ PLAY - Reanudando");
  } else {
    audioEngine.pause();
    showToast("⏸ PAUSE - Pausado");
  }
  updateScreenCanvas();
}

function nextTrack() {
  audioEngine.playClickSound();
  if (!state.isPowerOn) {
    powerOnSilent();
  }

  const currentGenre = MUSIC_LIBRARY[state.genreIndex];
  state.trackIndex = (state.trackIndex + 1) % currentGenre.tracks.length;
  state.trackTime = 0;

  showToast(`⏭ ADELANTE: ${currentGenre.tracks[state.trackIndex].title}`);

  if (state.isPlaying) {
    audioEngine.pause();
    audioEngine.play();
  }
  updateScreenCanvas();
}

function handleAtrasButton() {
  audioEngine.playClickSound();
  if (!state.isPowerOn) {
    powerOnSilent();
  }

  const now = Date.now();
  const timeDiff = now - state.lastAtrasClickTime;
  state.lastAtrasClickTime = now;

  const currentGenre = MUSIC_LIBRARY[state.genreIndex];

  if (timeDiff < 500) {
    state.trackIndex = (state.trackIndex - 1 + currentGenre.tracks.length) % currentGenre.tracks.length;
    state.trackTime = 0;
    showToast(`⏮ ATRÁS (Anterior): ${currentGenre.tracks[state.trackIndex].title}`);
  } else {
    state.trackTime = 0;
    showToast("↺ ATRÁS: Canción Reiniciada (Doble click = Anterior)");
  }

  if (state.isPlaying) {
    audioEngine.pause();
    audioEngine.play();
  }
  updateScreenCanvas();
}

// Reset Camera Button
document.getElementById('btn-reset-cam')?.addEventListener('click', () => {
  camera.position.set(0, 0.5, 4.2);
  controls.target.set(0, 0, 0);
  controls.update();
  showToast("🎥 Cámara Reiniciada");
});

const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
  }, 2200);
}

// ==========================================
// 8. RENDER LOOP
// ==========================================
const clock = new THREE.Clock();
let spotifyPollTimer = 0;

function updateSpotifyOverlay() {
  const overlay = document.getElementById('spotify-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.classList.remove('visible');
  }
}

function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();

  if (SpotifyAuth.isConnected) {
    if (state.isPowerOn && SpotifyAuth.isPlaying) {
      SpotifyAuth.trackPosition = (SpotifyAuth.trackPosition || 0) + delta;
    }
    spotifyPollTimer += delta;
    if (spotifyPollTimer > 1.2) {
      spotifyPollTimer = 0;
      SpotifyAuth.getPlaybackState();
    }
  }

  updateScreenCanvas();
  updateSpotifyOverlay();
  updateButtonAnimations();

  controls.update();
  renderer.render(scene, camera);
}

animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
