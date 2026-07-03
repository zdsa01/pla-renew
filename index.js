// index.js - PellaFree 自动续期脚本 (Node.js / GitHub Actions 专供版)

async function main(env) {
  console.log('开始执行 PellaFree 自动续期...');

  const accounts = parseAccounts(env.ACCOUNT);
  if (accounts.length === 0) {
    console.log('未找到有效账号，请检查 GitHub Secrets 配置');
    return;
  }

  const results = [];

  for (const account of accounts) {
    console.log(`\n=============================`);
    console.log(`处理账号: ${account.email}`);
    try {
      const result = await processAccount(account);
      results.push(result);
    } catch (error) {
      console.error(`账号 ${account.email} 处理失败:`, error.message);
      results.push({
        email: account.email,
        error: error.message,
        servers: [],
        renewResults: []
      });
    }
    await delay(2000);
  }

  if (env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
    await sendTelegramNotification(env, results);
  }

  console.log('\n所有续期任务执行完毕！');
}

// ==================== 账号解析 ====================

function parseAccounts(accountStr) {
  if (!accountStr) return [];

  // 支持两种格式：
  // 1. "email-----password"（用 ----- 分隔）
  // 2. "email,password"（用逗号分隔）
  return accountStr
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      let email, password;
      if (line.includes('-----')) {
        [email, password] = line.split('-----').map(s => s.trim());
      } else if (line.includes(',')) {
        [email, password] = line.split(',').map(s => s.trim());
      } else {
        return null;
      }
      return { email, password };
    })
    .filter(acc => acc && acc.email && acc.password);
}

// ==================== 主流程 ====================

async function processAccount(account) {
  console.log('[登录中] 正在获取认证 token...');

  // 最多重试 3 次登录
  let authData = null;
  let loginError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      authData = await login(account.email, account.password);
      break;
    } catch (err) {
      loginError = err;
      console.warn(`[登录尝试 ${attempt}/3] 失败: ${err.message}`);
      if (attempt < 3) await delay(attempt * 3000);
    }
  }

  if (!authData?.token) {
    throw new Error(`登录持续失败 (${loginError?.message || '未知原因'})`);
  }

  console.log(`✅ 账号 ${account.email} 登录成功`);

  // 第一步：获取服务器列表（带重试）
  let servers = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      servers = await getServers(authData.token);
      console.log(`初始获取到 ${servers.length} 个服务器`);
      break;
    } catch (err) {
      console.warn(`[获取服务器 ${attempt}/3] 失败: ${err.message}`);
      if (attempt < 3) await delay(attempt * 2000);
    }
  }

  if (servers.length === 0) {
    throw new Error('无法获取任何服务器');
  }

  // 第二步：多重唤醒 + 轮询等待广告下发
  let adsFound = false;
  if (servers.length > 0) {
    console.log('🔄 正在发送 detailed 和 info 请求以触发后台生成广告...');
    for (const server of servers) {
      await triggerServerDetail(authData.token, server.id);
      await triggerServerInfo(authData.token, server.id);
      await delay(500);
    }

    console.log('唤醒请求发送完毕，开始轮询等待广告下发 (最大等待 20 秒)...');

    for (let attempt = 1; attempt <= 5; attempt++) {
      await delay(4000);
      servers = await getSServersSafe(authData.token);

      let totalUnclaimed = 0;
      for (const s of servers) {
        const links = s.renew_links || [];
        totalUnclaimed += links.filter(l => l.claimed === false).length;
      }

      if (totalUnclaimed > 0) {
        console.log(`✅ [第 ${attempt} 次查询] 发现 ${totalUnclaimed} 个可用广告。`);
        adsFound = true;
        break;
      } else {
        console.log(`⏳ [第 ${attempt} 次查询] 尚未生成广告，继续等待...`);
      }
    }

    if (!adsFound) {
      console.log('⚠️ 等待超时，Pella 仍未下发广告（或今日已达上限）。将继续尝试续期...');
    }
  }

  // 记录续期前的状态
  const beforeState = {};
  for (const server of servers) {
    const renewLinks = server.renew_links || [];
    const unclaimedCount = renewLinks.filter(l => l.claimed === false).length;
    beforeState[server.id] = {
      expiry: server.expiry,
      totalLinks: renewLinks.length,
      unclaimedLinks: unclaimedCount
    };
  }

  // 第三步：执行续期和重启
  const renewResults = [];
  let totalRenewSuccess = 0;
  let totalRenewFail = 0;

  for (const server of servers) {
    const renewLinks = server.renew_links || [];
    const unclaimedLinks = renewLinks.filter(link => link.claimed === false);

    console.log(`🖥️ 服务器 ${server.id}: 总计${renewLinks.length}, 可用${unclaimedLinks.length}`);

    if (unclaimedLinks.length === 0) {
      renewResults.push({
        serverId: server.id,
        skipped: true,
        message: '无可用链接'
      });
    } else {
      for (let i = 0; i < unclaimedLinks.length; i++) {
        const renewLink = unclaimedLinks[i];
        console.log(`  📌 处理续期链接 ${i + 1}/${unclaimedLinks.length}`);

        try {
          const result = await renewServer(authData.token, server.id, renewLink.link);
          renewResults.push({
            serverId: server.id,
            success: result.success,
            message: result.message
          });
          if (result.success) totalRenewSuccess++;
          else totalRenewFail++;
          console.log(`  → ${result.success ? '✅ 成功' : '❌ 失败'}: ${result.message}`);
        } catch (error) {
          console.error(`  ❌ 续期异常:`, error.message);
          renewResults.push({
            serverId: server.id,
            success: false,
            message: error.message
          });
          totalRenewFail++;
        }
        await delay(2000);
      }
    }

    // 无条件强制重启
    console.log(`  🔄 服务器 ${server.id} 正在发送重启请求...`);
    try {
      await delay(2000);
      const redeployResult = await redeployServer(authData.token, server.id);
      renewResults.push({
        serverId: server.id,
        isRedeploy: true,
        success: redeployResult.success,
        message: redeployResult.message
      });
      console.log(`  → ${redeployResult.success ? '✅ 重启成功' : '❌ 重启失败'}: ${redeployResult.message}`);
    } catch (error) {
      console.error(`  ❌ 重启异常:`, error.message);
      renewResults.push({
        serverId: server.id,
        isRedeploy: true,
        success: false,
        message: error.message
      });
    }
  }

  // 最终刷新状态
  await delay(3000);
  try {
    servers = await getSServersSafe(authData.token);
  } catch {
    servers = servers; // 保持上一次的结果
  }

  console.log(`\n📊 本次总结: 续期成功 ${totalRenewSuccess}, 失败 ${totalRenewFail}`);

  return {
    email: account.email,
    servers: servers.map(s => {
      const before = beforeState[s.id] || {};
      const renewLinks = s.renew_links || [];
      return {
        id: s.id,
        ip: s.ip,
        status: s.status,
        expiry: s.expiry,
        beforeExpiry: before.expiry,
        beforeUnclaimedLinks: before.unclaimedLinks || 0,
        totalLinks: renewLinks.length,
        currentUnclaimedLinks: renewLinks.filter(l => l.claimed === false).length
      };
    }),
    renewResults,
    summary: {
      totalRenewSuccess,
      totalRenewFail
    }
  };
}

// 安全获取服务器列表（捕获异常不抛出）
async function getSServersSafe(token) {
  try {
    return await getServers(token);
  } catch {
    return [];
  }
}

// ==================== API 调用 ====================

async function login(email, password) {
  const CLERK_API_VERSION = '2024-11-24';
  const CLERK_JS_VERSION = '5.125.7';

  const signInUrl = `https://clerk.pella.app/v1/client/sign_ins?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`;

  const signInBody = new URLSearchParams({
    identifier: email,
    password: password,
    strategy: 'password'
  }).toString();

  console.log(`[登录] POST ${signInUrl.substring(0, 60)}...`);

  const signInResponse = await fetch(signInUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://www.pella.app',
      'Referer': 'https://www.pella.app/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)'
    },
    body: signInBody
  });

  if (!signInResponse.ok) {
    const errorBody = await signInResponse.text();
    throw new Error(`登录 HTTP 失败: ${signInResponse.status} - ${errorBody.substring(0, 200)}`);
  }

  const signInData = await signInResponse.json();

  // 调试：打印返回结构
  console.log(`[登录响应] response keys: ${Object.keys(signInData.response || {}).join(', ')}`);
  console.log(`[登录响应] client sessions: ${(signInData.client?.sessions || []).length}`);

  let sessionId = null;
  let token = null;

  // 方式 1: 从 created_session_id 获取
  if (signInData.response?.created_session_id) {
    sessionId = signInData.response.created_session_id;
    console.log(`[登录] 创建了新 session: ${sessionId}`);
  }

  // 方式 2: 从已有 sessions 中取 token
  if (signInData.client?.sessions?.length > 0) {
    const session = signInData.client.sessions[0];
    sessionId = sessionId || session.id;
    if (session.last_active_token?.jwt) {
      token = session.last_active_token.jwt;
      console.log(`[登录] 获取到 token (长度: ${token.length})`);
    } else {
      console.log(`[登录] ⚠️ session 存在但没有 last_active_token.jwt`);
    }
  }

  // 如果还没有 token，尝试从新创建的 session 中获取
  if (!token && sessionId) {
    console.log(`[登录] 尝试从 session 获取 token...`);
    token = await getSessionToken(sessionId);
  }

  if (!token) {
    throw new Error('未能获取到 JWT token，响应数据可能已变更');
  }

  return { token, sessionId };
}

// 通过 session ID 获取 token（备用方案）
async function getSessionToken(sessionId) {
  const tokenUrl = `https://clerk.pella.app/v1/client/sessions/${sessionId}/tokens`;

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://www.pella.app',
      'Referer': 'https://www.pella.app/'
    },
    body: JSON.stringify({})
  });

  if (!response.ok) {
    throw new Error(`获取 session token 失败: ${response.status}`);
  }

  const data = await response.json();
  return data.token?.jwt || null;
}

async function getServers(token) {
  const ts = new Date().getTime();
  const url = `https://api.pella.app/user/servers?_t=${ts}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Origin': 'https://www.pella.app',
      'Referer': 'https://www.pella.app/',
      'Cache-Control': 'no-cache',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`获取服务器列表失败: ${response.status} - ${errorText.substring(0, 200)}`);
  }

  const data = await response.json();
  return data.servers || [];
}

async function triggerServerDetail(token, serverId) {
  try {
    await fetch(`https://api.pella.app/server/detailed?id=${serverId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Origin': 'https://www.pella.app',
        'Referer': 'https://www.pella.app/'
      }
    });
  } catch (err) {
    // 静默忽略
  }
}

async function triggerServerInfo(token, serverId) {
  try {
    await fetch(`https://api.pella.app/server/info?id=${serverId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Origin': 'https://www.pella.app',
        'Referer': 'https://www.pella.app/'
      }
    });
  } catch (err) {
    // 静默忽略
  }
}

async function renewServer(token, serverId, renewLink) {
  const linkId = renewLink.split('/renew/')[1];
  if (!linkId) return { success: false, message: '无效链接' };

  const response = await fetch(`https://api.pella.app/server/renew?id=${linkId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Origin': 'https://www.pella.app',
      'Referer': 'https://www.pella.app/'
    },
    body: '{}'
  });

  const responseText = await response.text();
  try {
    const data = JSON.parse(responseText);
    if (data.success) return { success: true, message: '续期成功' };
    if (data.error) return { success: false, message: data.error };
    return { success: false, message: '未知响应' };
  } catch {
    return { success: false, message: `解析失败: ${responseText.substring(0, 100)}` };
  }
}

async function redeployServer(token, serverId) {
  const bodyParams = new URLSearchParams({ id: serverId });
  const response = await fetch('https://api.pella.app/server/redeploy', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://www.pella.app',
      'Referer': 'https://www.pella.app/'
    },
    body: bodyParams.toString()
  });

  if (!response.ok) return { success: false, message: `HTTP异常 ${response.status}` };

  const responseText = await response.text();
  if (!responseText) return { success: true, message: '重启指令已发送' };

  try {
    const data = JSON.parse(responseText);
    if (data.success || data.message === 'success') {
      return { success: true, message: '重启指令已发送' };
    }
    if (data.error) return { success: false, message: data.error };
    return { success: false, message: '未知响应' };
  } catch {
    return { success: true, message: '重启指令已发送' };
  }
}

// ==================== Telegram 通知 ====================

async function sendTelegramNotification(env, results) {
  const message = formatNotificationMessage(results);
  const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`;

  // Telegram 消息体限制约 4096 字符，超长时截断
  const truncatedMessage = message.length > 4000 ? message.substring(0, 3997) + '\n\n...(消息过长已截断)' : message;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TG_CHAT_ID,
        text: truncatedMessage,
        parse_mode: 'HTML'
      })
    });

    if (response.ok) {
      console.log('✅ Telegram 通知发送成功');
    } else {
      const errorText = await response.text();
      console.error(`❌ Telegram 通知发送失败: ${response.status} - ${errorText}`);
    }
  } catch (err) {
    console.error(`❌ Telegram 通知发送异常: ${err.message}`);
  }
}

function formatNotificationMessage(results) {
  const lines = ['<b>📋 PellaFree 续期报告</b>\n'];
  const now = new Date();

  for (const result of results) {
    lines.push(`<b>账号: ${escapeHtml(result.email)}</b>`);

    if (result.error) {
      lines.push(`<font color="#ff6b6b">错误: ${escapeHtml(result.error)}</font>\n`);
      continue;
    }

    if (result.servers.length === 0) {
      lines.push('暂无服务器\n');
      continue;
    }

    for (const server of result.servers) {
      const statusIcon = server.status === 'running' ? '🟢' : '🔴';
      const statusText = server.status === 'running' ? '运行中' : '已关机';
      lines.push(`${statusIcon} <code>${server.ip || 'N/A'}</code> [ID: ${server.id}]`);
      lines.push(`   状态: ${statusText}`);

      const remainingTime = calcRemaining(server.expiry, now);
      if (server.beforeExpiry && server.beforeExpiry !== server.expiry) {
        const beforeRemaining = calcRemaining(server.beforeExpiry, now);
        lines.push(`   到期: ${beforeRemaining} → <font color='#51cf66">${remainingTime}</font> [已续期]`);
      } else {
        lines.push(`   到期: ${remainingTime}`);
      }

      lines.push(`   广告: ${server.currentUnclaimedLinks}/${server.totalLinks} 可用`);
    }

    const actualRenews = result.renewResults.filter(r => !r.skipped && !r.isRedeploy);
    const redeploys = result.renewResults.filter(r => r.isRedeploy);

    if (actualRenews.length > 0) {
      const successCount = actualRenews.filter(r => r.success).length;
      lines.push(`   续期: <font color="${successCount === actualRenews.length ? '#51cf66' : '#fcc419'}">${successCount}/${actualRenews.length} 成功</font>`);
      for (const r of actualRenews.filter(r => !r.success)) {
        lines.push(`     ❌ ${escapeHtml(r.message)}`);
      }
    } else {
      lines.push('   续期: 无可用广告');
    }

    if (redeploys.length > 0) {
      const successCount = redeploys.filter(r => r.success).length;
      lines.push(`   重启: <font color="${successCount === redeploys.length ? '#51cf66' : '#fcc419'}">${successCount}/${redeploys.length} 成功</font>`);
      for (const r of redeploys.filter(r => !r.success)) {
        lines.push(`     ❌ ${escapeHtml(r.message)}`);
      }
    }

    lines.push('');
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('<i>PellaFree Actions Auto Renewal</i>');
  lines.push(`<i>${now.toLocaleString('zh-CN', { timeZone: 'America/Chicago' })}</i>`);
  return lines.join('\n');
}

function calcRemaining(expiry, now) {
  if (!expiry) return 'N/A';
  try {
    // 匹配格式: HH:mm:ss MM/DD/YYYY
    const match = expiry.match(/(\d{2}):(\d{2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})/);
    if (!match) return expiry; // 如果不是预期格式，直接返回原值

    const [, hour, minute, second, day, month, year] = match;
    const expiryDate = new Date(Date.UTC(year, parseInt(month) - 1, day, parseInt(hour), parseInt(minute), parseInt(second)));
    const diff = expiryDate.getTime() - now.getTime();

    if (diff <= 0) return '<font color="#ff6b6b">已过期</font>';

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (days > 0) return `${days}天${hours}时${minutes}分`;
    if (hours > 0) return `${hours}时${minutes}分`;
    return `${minutes}分`;
  } catch {
    return 'N/A';
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== 入口 ====================

(async () => {
  await main(process.env);
})();
