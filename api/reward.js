import crypto from 'crypto';

const API = 'https://mainnet.ackinacki.org/graphql';
const POPIT_CODE_HASH = '18365592c5f1e7d319cc1a2fd58fa05ca3afbe4ac49e73bc765d139a2e2d7a29';

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const PREMIUM_CHAT_ID = process.env.TG_PREMIUM_CHANNEL_ID;

// Cache in-memory per code_hash (statico, non cambia mai)
const codeHashCache = new Map();

// ---- Config per Vercel timeout ----
export const config = {
  maxDuration: 60, // 60s su Pro plan
};

// ---- Telegram auth (invariato) ----
function checkTelegramAuth(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  const data = [];
  params.forEach((value, key) => {
    if (key !== 'hash') data.push(`${key}=${value}`);
  });
  data.sort();
  const dataCheckString = data.join('\n');
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN)
    .digest();
  const calcHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');
  if (calcHash !== hash) return null;
  const userStr = params.get('user');
  return userStr ? JSON.parse(userStr) : null;
}

async function isPremiumMember(userId) {
  if (!PREMIUM_CHAT_ID || !BOT_TOKEN) return false;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember` +
    `?chat_id=${encodeURIComponent(PREMIUM_CHAT_ID)}` +
    `&user_id=${userId}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!data.ok) return false;
  return ['member', 'administrator', 'creator'].includes(data.result.status);
}

// ---- GraphQL helper con retry e timeout ----
async function graphql(query, variables, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    
    const json = await res.json();
    if (json.errors) {
      throw new Error(json.errors[0].message || 'GraphQL error');
    }
    return json.data;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ---- Fetch parallelo con Promise.all ----
async function fetchAllMessages(addr, maxMessages = 2000) {
  const taps = [];
  let hasNextPage = true;
  let cursor = null;
  const maxIterations = 20; // Safety limit
  let iterations = 0;

  while (hasNextPage && taps.length < maxMessages && iterations < maxIterations) {
    const msgData = await graphql(
      `query($a:String!, $after:String){
        blockchain{
          account(address:$a){
            messages(first:50, msg_type:[IntIn], after:$after){
              edges{
                node{
                  id
                  created_at
                  src
                  value_other{currency value}
                  body
                }
              }
              pageInfo{
                endCursor
                hasNextPage
              }
            }
          }
        }
      }`,
      { a: addr, after: cursor }
    );

    const messages = msgData.blockchain.account.messages;
    const edges = messages?.edges || [];
    
    edges.forEach(({ node }) => {
      if (node.value_other) {
        const reward = node.value_other.find(v => v.currency === 1);
        if (reward) {
          taps.push({
            id: node.id,
            src: node.src,
            reward: parseInt(reward.value, 16) / 1e9,
            timestamp: node.created_at,
            body: node.body
          });
        }
      }
    });

    hasNextPage = messages.pageInfo?.hasNextPage || false;
    cursor = messages.pageInfo?.endCursor || null;
    iterations++;
  }

  return taps;
}

// ---- Fetch code_hash con caching e parallelizzazione ----
async function fetchCodeHashesBatch(addresses) {
  const uncached = addresses.filter(addr => !codeHashCache.has(addr));
  
  if (uncached.length === 0) {
    // Tutti in cache
    return Object.fromEntries(addresses.map(addr => [addr, codeHashCache.get(addr)]));
  }

  // Fetch in parallelo chunks da 20
  const chunkSize = 20;
  const chunks = [];
  for (let i = 0; i < uncached.length; i += chunkSize) {
    chunks.push(uncached.slice(i, i + chunkSize));
  }

  // Parallelizza tutte le query dei chunk
  const chunkPromises = chunks.map(async (chunk, chunkIdx) => {
    const fields = chunk.map((address, idx) => `
      a${chunkIdx}_${idx}: account(address: "${address}") {
        info { address code_hash }
      }
    `).join('\n');

    const q = `query{
      blockchain{
        ${fields}
      }
    }`;

    const accData = await graphql(q, {});
    
    const results = {};
    chunk.forEach((address, idx) => {
      const acc = accData.blockchain[`a${chunkIdx}_${idx}`];
      const codeHash = acc?.info?.code_hash || null;
      codeHashCache.set(address, codeHash); // Salva in cache
      results[address] = codeHash;
    });
    
    return results;
  });

  // Aspetta tutte le query parallele
  const allResults = await Promise.all(chunkPromises);
  
  // Merge risultati
  const codeHashByAddress = {};
  allResults.forEach(result => Object.assign(codeHashByAddress, result));
  
  // Aggiungi anche quelli cached
  addresses.forEach(addr => {
    if (!codeHashByAddress[addr]) {
      codeHashByAddress[addr] = codeHashCache.get(addr);
    }
  });

  return codeHashByAddress;
}

// ---- Handler principale ----
export default async function handler(req, res) {
  const startTime = Date.now();
  
  // Headers per caching client-side
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
  
  try {
    const addr = (req.query.address || '').trim();
    if (!addr) {
      return res.status(400).json({ error: 'Missing address' });
    }

    // 1) Auth Telegram
    const initData = req.headers['x-telegram-init-data'] || '';
    const user = checkTelegramAuth(initData);
    if (!user) {
      return res.status(401).json({ error: 'Open the tracker from the Telegram bot' });
    }

    // 2) Premium check
    const premium = await isPremiumMember(user.id);
    if (!premium) {
      return res.status(403).json({ 
        error: 'Subscribe to the GOLD channel: https://t.me/+GsMPPRnYcMtiOTY8' 
      });
    }

    // 3) Fetch balance e messages in PARALLELO
    const [balData, taps] = await Promise.all([
      graphql(
        `query($a:String!){
          blockchain{
            account(address:$a){
              info{
                balance_other{currency value}
              }
            }
          }
        }`,
        { a: addr }
      ),
      fetchAllMessages(addr)
    ]);

    const nackl = balData.blockchain.account?.info?.balance_other
      ?.find(b => b.currency === 1);
    const balance = nackl ? (parseInt(nackl.value, 16) / 1e9) : 0;

    // 4) Fetch code_hash in parallelo con caching
    const uniqueSrc = [...new Set(taps.map(t => t.src))];
    const codeHashByAddress = await fetchCodeHashesBatch(uniqueSrc);

    // 5) Assegna code_hash e flag is_popit
    taps.forEach(t => {
      const ch = codeHashByAddress[t.src] || null;
      t.src_code_hash = ch;
      t.is_popit = (ch === POPIT_CODE_HASH);
    });

    taps.sort((a, b) => b.timestamp - a.timestamp);
    const totalReward = taps.reduce((s, t) => s + t.reward, 0);

    const executionTime = Date.now() - startTime;
    
    return res.status(200).json({
      address: addr,
      balance,
      tapsCount: taps.length,
      totalReward,
      taps,
      meta: {
        executionTime: `${executionTime}ms`,
        cached: codeHashCache.size
      }
    });

  } catch (err) {
    console.error('Error:', err);
    const executionTime = Date.now() - startTime;
    return res.status(500).json({ 
      error: err.message || 'Internal error',
      executionTime: `${executionTime}ms`
    });
  }
}
