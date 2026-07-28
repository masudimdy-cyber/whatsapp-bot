const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const app = express();

let qrDataUrl = null;

app.get('/qr', async (req, res) => {
  if (qrDataUrl) {
    res.send(<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;"><img src="${qrDataUrl}" style="width:500px;height:500px;"/></body></html>);
  } else {
    res.send('QR code not ready yet. Refresh in a few seconds.');
  }
});

app.listen(8080, () => console.log('QR available at http://localhost:8080/qr'));
const CACHE_FILE  = path.join(__dirname, 'message_cache.json');
const MEDIA_DIR   = path.join(__dirname, 'media_cache');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const MAX_CACHE   = 5000;

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    console.error('config.json introuvable.');
    process.exit(1);
  }
}
const config = loadConfig();
let awayMode = false;
const conversationHistory = {};

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch {}
  return {};
}
let messageCache = loadCache();

function saveCache() {
  const keys = Object.keys(messageCache);
  if (keys.length > MAX_CACHE) {
    keys.sort((a, b) => messageCache[a].timestamp - messageCache[b].timestamp)
        .slice(0, keys.length - MAX_CACHE)
        .forEach(k => delete messageCache[k]);
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(messageCache, null, 2));
}

function unwrapViewOnce(m) {
  if (!m) return { content: null, isViewOnce: false };
  const wrapper =
    m.viewOnceMessage?.message ||
    m.viewOnceMessageV2?.message ||
    m.viewOnceMessageV2Extension?.message;
  if (wrapper) return { content: wrapper, isViewOnce: true };
  const direct = m.imageMessage?.viewOnce || m.videoMessage?.viewOnce || m.audioMessage?.viewOnce;
  return { content: m, isViewOnce: !!direct };
}

function extractText(msg) {
  const { content } = unwrapViewOnce(msg.message);
  if (!content) return null;
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption || null
  );
}

function getMediaType(msg) {
  const { content } = unwrapViewOnce(msg.message);
  if (!content) return null;
  if (content.imageMessage) return 'image';
  if (content.videoMessage) return 'video';
  if (content.audioMessage) return 'audio';
  if (content.stickerMessage) return 'sticker';
  return null;
}

const isStatus = jid => jid === 'status@broadcast';

async function generateAIReply(senderName, incomingText, jid) {
  const apiKey = config.anthropicApiKey;
  if (!apiKey || apiKey.startsWith('sk-ant-METS')) return null;

  if (!conversationHistory[jid]) conversationHistory[jid] = [];
  conversationHistory[jid].push({ role: 'user', content: '[' + senderName + ']: ' + incomingText });
  if (conversationHistory[jid].length > 10) conversationHistory[jid].shift();

  const systemPrompt = 'Tu es l assistant personnel de ' + config.master.name + '. Tu reponds a sa place quand il est absent. Reponds TOUJOURS dans la meme langue que le message recu. Langues possibles : ' + config.master.languages.join(', ') + '. Reponds de facon naturelle et courte, comme dans une vraie conversation WhatsApp. Ne dis jamais que tu es un bot sauf si on te le demande directement. Profil de ' + config.master.name + ' : ' + config.master.profile + ' Style : ' + config.master.style + ' Expressions courantes : ' + config.master.phrases.join(', ');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: systemPrompt,
        messages: conversationHistory[jid],
      }),
    });
    const data = await response.json();
    const reply = data.content && data.content[0] ? data.content[0].text : null;
    if (reply) conversationHistory[jid].push({ role: 'assistant', content: reply });
    return reply;
  } catch (err) {
    console.error('Erreur API Claude:', err.message);
    return null;
  }
}

async function handleCommand(sock, msg, text) {
  const cmd = text.trim().toLowerCase();
  const jid = msg.key.remoteJid;

  if (cmd === '/absent on') {
    awayMode = true;
    await sock.sendMessage(jid, { text: 'Mode absent active.' });
    return true;
  }
  if (cmd === '/absent off') {
    awayMode = false;
    await sock.sendMessage(jid, { text: 'Mode absent desactive.' });
    return true;
  }
  if (cmd === '/statut') {
    const etat = awayMode ? 'Mode absent : ACTIVE' : 'Mode absent : DESACTIVE';
    await sock.sendMessage(jid, { text: etat });
    return true;
  }
  return false;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'));

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', function(update) {
    if (update.qr) { 
  QRCode.toDataURL(update.qr, (err, url) => { qrDataUrl = url; });
  require('qrcode-terminal').generate(update.qr, { small: true }); 
}
    const connection = update.connection;
{    const lastDisconnect = update.lastDisconnect;
}    if (connection === 'close') {
      const code = new Boom(lastDisconnect && lastDisconnect.error).output.statusCode;
      if (code !== DisconnectReason.loggedOut) startBot();
    } else if (connection === 'open') {
      console.log('Bot connecte a WhatsApp.');
      console.log('Commandes : /absent on | /absent off | /statut');
    }
  });

  sock.ev.on('messages.upsert', async function(param) {
    const messages = param.messages;
    const type = param.type;
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || !msg.key || !msg.key.id) continue;

      const jid = msg.key.remoteJid;
      const fromMe = msg.key.fromMe;
      const id = msg.key.id;
      const text = extractText(msg);
      const mediaType = getMediaType(msg);
      const viewOnce = unwrapViewOnce(msg.message).isViewOnce;
      const senderName = msg.pushName || jid;

      if (isStatus(jid)) {
        try {
          await sock.readMessages([msg.key]);
          console.log('Statut visionne : ' + senderName);
        } catch (err) {
          console.error('Erreur statut:', err.message);
        }
        continue;
      }

      let mediaPath = null;
      if (mediaType) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          mediaPath = path.join(MEDIA_DIR, id + '.bin');
          fs.writeFileSync(mediaPath, buffer);
        } catch (err) {
          console.error('Erreur download:', err.message);
        }
      }

      messageCache[id] = { from: jid, text: text, mediaType: mediaType, mediaPath: mediaPath, sender: senderName, timestamp: Date.now() };
      saveCache();

      if (viewOnce && mediaPath && (mediaType === 'image' || mediaType === 'video')) {
        try {
          const sendObj = { caption: 'Vu unique de ' + senderName };
          sendObj[mediaType] = fs.readFileSync(mediaPath);
          await sock.sendMessage(jid, sendObj);
          console.log('Vu unique republie : ' + senderName);
        } catch (err) {
          console.error('Erreur vu unique:', err.message);
        }
      }

      if (fromMe && text) {
        const handled = await handleCommand(sock, msg, text);
        if (handled) continue;
      }

      if (!fromMe && awayMode && text) {
        await new Promise(function(r) { setTimeout(r, 2000); });
        try {
          const reply = await generateAIReply(senderName, text, jid);
          if (reply) {
            await sock.sendMessage(jid, { text: reply }, { quoted: msg });
            console.log('Reponse auto : ' + senderName);
          }
        } catch (err) {
          console.error('Erreur reponse:', err.message);
        }
      }
    }
  });

  sock.ev.on('messages.update', async function(updates) {
    for (const update of updates) {
      const isRevoked = update.update && (update.update.message === null || update.update.messageStubType === 1);
      if (!isRevoked) continue;

      const original = messageCache[update.key && update.key.id];
      if (!original) continue;

      const jid = update.key.remoteJid;
      const recap = 'Message supprime par ' + original.sender + '\n\n' + (original.text || '(pas de texte)');

      try {
        if (original.mediaPath && fs.existsSync(original.mediaPath) && (original.mediaType === 'image' || original.mediaType === 'video')) {
          const sendObj = { caption: recap };
          sendObj[original.mediaType] = fs.readFileSync(original.mediaPath);
          await sock.sendMessage(jid, sendObj);
        } else {
          await sock.sendMessage(jid, { text: recap });
        }
        console.log('Message supprime republie : ' + original.sender);
      } catch (err) {
        console.error('Erreur republication:', err.message);
      }
    }
  });
}

startBot().catch(function(err) { console.error('Erreur demarrage:', err); });
