// index.js - PellaFree 自动续期脚本 (Node.js / GitHub Actions 专供版)

async function main(env) { console.log('开始执行 PellaFree 自动续期...');

const accounts = parseAccounts(env.ACCOUNT); if (accounts.length === 0) { console.log('未找到有效账号，请检查 GitHub Secrets 配置'); return; }

const results = [];

for (const account of accounts) { console.log(\n=============================); console.log(处理账号: ${account.email}); try { const result = await processAccount(account); results.push(result); } catch (error) { console.error(账号 ${account.email} 处理失败:, error.message); results.push({ email: account.email, error: error.message, servers: [], renewResults: [] }); } await delay(2000); }

if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) { await sendTelegramNotification(env, results); }

console.log('\n所有续期任务执行完毕！'); }

function parseAccounts(accountStr) { if (!accountStr) return [];

return accountStr .split('\n') .map(line => line.trim()) .filter(line => line && line.includes('-----')) .map(line => { const [email, password] = line.split('-----').map(s => s.trim()); return { email, password }; }) .filter(acc => acc.email && acc.password); }

async function processAccount(account) { const authData = await login(account.email, account.password);

if (!authData.token) { throw new Error('登录失败，无法获取 token'); }

console.log(账号 ${account.email} 登录成功);

// 第一步：获取初始服务器列表 let servers = await getServers(authData.token); console.log(初始获取到 ${servers.length} 个服务器);

// 第二步：多重唤醒 + 轮询等待 if (servers.length > 0) { console.log('正在发送 detailed 和 info 请求以触发后台生成广告...'); for (const server of servers) { await triggerServerDetail(authData.token, server.id); await triggerServerInfo(authData.token, server.id); await delay(500); }

console.log('唤醒请求发送完毕，开始轮询等待广告下发 (最大等待 20 秒)...');

let adsFound = false;
for (let attempt = 1; attempt <= 5; attempt++) {
  await delay(4000); // 每次等 4 秒
  servers = await getServers(authData.token);
  
  let totalUnclaimed = 0;
  for (const s of servers) {
    const links = s.renew_links || [];
    totalUnclaimed += links.filter(l => l.claimed === false).length;
  }
  
  if (totalUnclaimed > 0) {
    console.log(`[第 ${attempt} 次查询] 成功！已发现 ${totalUnclaimed} 个可用广告。`);
    adsFound = true;
    break; // 拿到广告就跳出循环
  } else {
    console.log(`[第 ${attempt} 次查询] 尚未生成广告，继续等待...`);
  }
}

if (!adsFound) {
  console.log('等待超时，Pella 仍未下发广告（或今日已达上限）。');
}
}

// 记录续期前的状态 const beforeState = {}; for (const server of servers) { const renewLinks = server.renew_links || []; const unclaimedCount = renewLinks.filter(l => l.claimed === false).length; beforeState[server.id] = { expiry: server.expiry, totalLinks: renewLinks.length, unclaimedLinks: unclaimedCount }; }

// 第三步：执行续期和重启 const renewResults = []; for (const server of servers) { const renewLinks = server.renew_links || []; const unclaimedLinks = renewLinks.filter(link => link.claimed === false);

console.log(`服务器 ${server.id}: 总${renewLinks.length}, 可用${unclaimedLinks.length}`);

if (unclaimedLinks.length === 0) {
  renewResults.push({
    serverId: server.id,
    skipped: true,
    message: '无可用链接'
  });
} else {
  for (let i = 0; i < unclaimedLinks.length; i++) {
    const renewLink = unclaimedLinks[i];
    console.log(`处理续期链接 ${i + 1}/${unclaimedLinks.length}`);
    
    try {
      const result = await renewServer(authData.token, server.id, renewLink.link);
      renewResults.push({
        serverId: server.id,
        success: result.success,
        message: result.message
      });
      console.log(`续期结果: ${result.success ? '成功' : '失败'} - ${result.message}`);
    } catch (error) {
      console.error(`续期失败:`, error.message);
      renewResults.push({
        serverId: server.id,
        success: false,
        message: error.message
      });
    }
    await delay(2000);
  }
}

// 无条件强制重启
console.log(`服务器 ${server.id} 正在发送重启请求...`);
try {
  await delay(2000);  
  const redeployResult = await redeployServer(authData.token, server.id);
  renewResults.push({
    serverId: server.id,
    isRedeploy: true, 
    success: redeployResult.success,
    message: redeployResult.message
  });
  console.log(`重启结果: ${redeployResult.success ? '成功' : '失败'} - ${redeployResult.message}`);
} catch (error) {
  console.error(`重启失败:`, error.message);
  renewResults.push({
    serverId: server.id,
    isRedeploy: true,
    success: false,
    message: error.message
  });
}
}

await delay(2000); servers = await getServers(authData.token);

return { email: account.email, servers: servers.map(s => { const before = beforeState[s.id] || {}; const renewLinks = s.renew_links || []; return { id: s.id, ip: s.ip, status: s.status, expiry: s.expiry, beforeExpiry: before.expiry, beforeUnclaimedLinks: before.unclaimedLinks || 0, totalLinks: renewLinks.length, currentUnclaimedLinks: renewLinks.filter(l => l.claimed === false).length }; }), renewResults }; }

async function login(email, password) { const CLERK_API_VERSION = '2025-11-10'; const CLERK_JS_VERSION = '5.125.7';

const signInUrl = https://clerk.pella.app/v1/client/sign_ins?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION};

const signInBody = new URLSearchParams({ locale: 'zh-CN', identifier: email, password: password, strategy: 'password' });

const signInResponse = await fetch(signInUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': 'https://www.pella.app ', 'Referer': 'https://www.pella.app/ ', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, body: signInBody.toString() });

if (!signInResponse.ok) { const errorBody = await signInResponse.text(); throw new Error(登录请求失败: ${signInResponse.status} - ${errorBody}); }

const signInData = await signInResponse.json();

let sessionId = null; let token = null;

if (signInData.response?.created_session_id) { sessionId = signInData.response.created_session_id; }

if (signInData.client?.sessions?.length > 0) { const session = signInData.client.sessions[0]; sessionId = sessionId || session.id; if (session.last_active_token?.jwt) { token = session.last_active_token.jwt; } }

return { token }; }

async function getServers(token) { const ts = new Date().getTime(); const response = await fetch(https://api.pella.app/user/servers?_t=${ts}, { method: 'GET', headers: { 'Authorization': Bearer ${token}, 'Content-Type': 'application/json', 'Origin': 'https://www.pella.app ', 'Referer': 'https://www.pella.app/ ', 'Cache-Control': 'no-cache', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });

if (!response.ok) { throw new Error(获取服务器列表失败: ${response.status}); }

const data = await response.json(); return data.servers || []; }

async function triggerServerDetail(token, serverId) { try { await fetch(https://api.pella.app/server/detailed?id=${serverId}, { method: 'GET', headers: { 'Authorization': Bearer ${token}, 'Content-Type': 'application/json', 'Origin': 'https://www.pella.app ', 'Referer': 'https://www.pella.app/ ', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }); } catch (err) {} }

async function triggerServerInfo(token, serverId) { try { await fetch(https://api.pella.app/server/info?id=${serverId}, { method: 'GET', headers: { 'Authorization': Bearer ${token}, 'Content-Type': 'application/json', 'Origin': 'https://www.pella.app ', 'Referer': 'https://www.pella.app/ ', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }); } catch (err) {} }

async function renewServer(token, serverId, renewLink) { const linkId = renewLink.split('/renew/')[1]; if (!linkId) return { success: false, message: '无效链接' };

const response = await fetch(https://api.pella.app/server/renew?id=${linkId}, { method: 'POST', headers: { 'Authorization': Bearer ${token}, 'Content-Type': 'application/json', 'Origin': 'https://www.pella.app ', 'Referer': 'https://www.pella.app/ ', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, body: '{}' });

const responseText = await response.text(); try { const data = JSON.parse(responseText); if (data.success) return { success: true, message: '续期成功' }; if (data.error) return { success: false, message: data.error }; return { success: false, message: '未知响应' }; } catch { return { success: false, message: '解析失败' }; } }

async function redeployServer(token, serverId) { const bodyParams = new URLSearchParams({ id: serverId }); const response = await fetch('https://api.pella.app/server/redeploy ', { method: 'POST', headers: { 'Authorization': Bearer ${token}, 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': 'https://www.pella.app ', 'Referer': 'https://www.pella.app/ ', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, body: bodyParams.toString() });

if (!response.ok) return { success: false, message: HTTP异常 ${response.status} };

const responseText = await response.text(); if (!responseText) return { success: true, message: '重启指令已发送' };

try { const data = JSON.parse(responseText); if (data.success || data.message === 'success' || response.status === 200) { return { success: true, message: '重启指令已发送' }; } if (data.error) return { success: false, message: data.error }; return { success: false, message: '未知响应' }; } catch { return { success: true, message: '重启指令已发送' }; } }

async function sendTelegramNotification(env, results) { const message = formatNotificationMessage(results); await fetch(https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: message, parse_mode: 'HTML' }) }); }

function formatNotificationMessage(results) { const lines = ['📋 PellaFree 续期报告', '']; const now = new Date();

for (const result of results) { lines.push(账号: ${escapeHtml(result.email)}); if (result.error) { lines.push(错误: ${escapeHtml(result.error)}\n); continue; } if (result.servers.length === 0) { lines.push('暂无服务器\n'); continue; }

for (const server of result.servers) {
  const statusText = server.status === 'running' ? '运行中' : '已关机';
  lines.push(`${statusText} | IP: <code>${server.ip || 'N/A'}</code>`);
  const remainingTime = calcRemaining(server.expiry, now);
  if (server.beforeExpiry && server.beforeExpiry !== server.expiry) {
    const beforeRemaining = calcRemaining(server.beforeExpiry, now);
    lines.push(`剩余: ${beforeRemaining} → ${remainingTime} [已续期]`);
  } else {
    lines.push(`剩余: ${remainingTime}`);
  }
  lines.push(`广告: ${server.currentUnclaimedLinks}/${server.totalLinks} 可用`);
}

const actualRenews = result.renewResults.filter(r => !r.skipped && !r.isRedeploy);
const redeploys = result.renewResults.filter(r => r.isRedeploy);

if (actualRenews.length > 0) {
  const successCount = actualRenews.filter(r => r.success).length;
  lines.push(`续期: ${successCount}/${actualRenews.length} 成功`);
  for (const r of actualRenews.filter(r => !r.success)) lines.push(`  失败: ${escapeHtml(r.message)}`);
} else {
  lines.push(`续期: 无可用广告`);
}

if (redeploys.length > 0) {
  const successCount = redeploys.filter(r => r.success).length;
  lines.push(`重启: ${successCount}/${redeploys.length} 成功`);
  for (const r of redeploys.filter(r => !r.success)) lines.push(`  重启失败: ${escapeHtml(r.message)}`);
}
lines.push('');
}

lines.push('────────────────────'); lines.push('PellaFree Actions Auto Renewal'); lines.push(${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}); return lines.join('\n'); }

function calcRemaining(expiry, now) { if (!expiry) return 'N/A'; try { const match = expiry.match(/(\d{2}):(\d{2}):(\d{2})\s+(\d{2})/(\d{2})/(\d{4})/); if (!match) return 'N/A'; const [, hour, minute, second, day, month, year] = match; const expiryDate = new Date(${year}-${month}-${day}T${hour}:${minute}:${second}Z); const diff = expiryDate.getTime() - now.getTime(); if (diff <= 0) return '已过期'; const days = Math.floor(diff / (1000 * 60 * 60 * 24)); const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)); const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)); if (days > 0) return ${days}天${hours}时${minutes}分; if (hours > 0) return ${hours}时${minutes}分; return ${minutes}分; } catch { return 'N/A'; } }

function escapeHtml(text) { if (!text) return ''; return text.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>'); }

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// 自动执行入口，读取 process.env 环境变量 (async () => { await main(process.env); })();
