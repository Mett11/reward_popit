import crypto from 'crypto';

const API = 'https://mainnet.ackinacki.org/graphql';
const POPIT_CODE_HASH = '18365592c5f1e7d319cc1a2fd58fa05ca3afbe4ac49e73bc765d139a2e2d7a29';

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const PREMIUM_CHAT_ID = process.env.TG_PREMIUM_CHANNEL_ID;

// ---- Telegram auth helpers ----

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
  const user = userStr ? JSON.parse(userStr) : null;
  return user; // { id, username, ... }
}

async function isPremiumMember(userId) {
  if (!PREMIUM_CHAT_ID || !BOT_TOKEN) return false;

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember` +
              `?chat_id=${encodeURIComponent(PREMIUM_CHAT_ID)}` +
              `&user_id=${userId}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!data.ok) return false;

  const status = data.result.status;
  return ['member', 'administrator', 'creator'].includes(status);
}

// ---- GraphQL helper ----

async function graphql(query, variables) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(json.errors[0].message || 'GraphQL error');
  }
  return json.data;
}

// ---- Handler ----

export default async function handler(req, res) {
  try {
    const addr = (req.query.address || '').trim();
    if (!addr) {
      return res.status(400).json({ error: 'Missing address' });
    }

    // 1) Verifica Telegram WebApp (initData)
    const initData = req.headers['x-telegram-init-data'] || '';
    const user = checkTelegramAuth(initData);
    if (!user) {
      return res.status(401).json({ error: 'Open the tracker from the Telegram bot' });
    }

    // 2) Verifica membership canale premium
    const premium = await isPremiumMember(user.id);
    if (!premium) {
      return res.status(403).json({ error: 'Subscribe to the GOLD channel: https://t.me/+GsMPPRnYcMtiOTY8' });
    }

    // 3) Balance NACKL
    const balData = await graphql(
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
    );

    const nackl = balData.blockchain.account?.info?.balance_other
      ?.find(b => b.currency === 1);
    const balance = nackl ? (parseInt(nackl.value, 16) / 1e9) : 0;

    // 4) Reward messages
    const taps = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
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

      if (taps.length > 2000) break;
    }

    // 5) code_hash per POPIT
    const uniqueSrc = [...new Set(taps.map(t => t.src))];
    const codeHashByAddress = {};

    if (uniqueSrc.length > 0) {
      const chunkSize = 20;
      for (let i = 0; i < uniqueSrc.length; i += chunkSize) {
        const chunk = uniqueSrc.slice(i, i + chunkSize);
        const fields = chunk.map((address, idx) => `
          a${i + idx}: account(address: "${address}") {
            info { address code_hash }
          }
        `).join('\n');

        const q = `query{
          blockchain{
            ${fields}
          }
        }`;

        const accData = await graphql(q, {});
        chunk.forEach((address, idx) => {
          const acc = accData.blockchain[`a${i + idx}`];
          codeHashByAddress[address] = acc?.info?.code_hash || null;
        });
      }
    }

    taps.forEach(t => {
      const ch = codeHashByAddress[t.src] || null;
      t.src_code_hash = ch;
      t.is_popit = (ch === POPIT_CODE_HASH);
    });

    taps.sort((a, b) => b.timestamp - a.timestamp);
    const totalReward = taps.reduce((s, t) => s + t.reward, 0);

    return res.status(200).json({
      address: addr,
      balance,
      tapsCount: taps.length,
      totalReward,
      taps
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
