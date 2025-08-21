// worker.js

// 导入 kv-asset-handler，用于服务静态文件
// 注意：在部署时，Cloudflare 的构建系统会自动处理这个导入
import { getAssetFromKV } from '@cloudflare/kv-asset-handler';

// ==========================================================
// 1. Worker 的主要入口点 (fetch for HTTP requests, scheduled for cron)
// ==========================================================

// Worker 的 HTTP 请求处理函数
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // --- A. 处理 API 请求 ---
        if (url.pathname.startsWith('/api/tasks')) {
            console.log(`Worker: Handling API request: ${url.pathname}, Method: ${request.method}`);
            try {
                // 调用您的 API 路由处理函数
                const response = await handleTaskApi(request, url, env);
                // 确保 handleTaskApi 返回了 Response 对象
                if (response) {
                    return response;
                } else {
                    console.error("handleTaskApi did not return a response for:", url.pathname);
                    return new Response(JSON.stringify({ message: "Internal Server Error: API handler did not return a response." }), {
                        status: 500,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
            } catch (error) {
                console.error("Error in API handler:", error);
                return new Response(JSON.stringify({
                    message: "Internal Server Error during API processing",
                    details: error.message || "An unexpected error occurred."
                }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        // --- B. 处理静态文件请求 (包括 index.html 和其他资源) ---
        // getAssetFromKV 会从 KV 命名空间 (__STATIC_CONTENT) 中查找并返回静态文件
        try {
            return await getAssetFromKV(
                { request, waitUntil: ctx.waitUntil },
                {
                    // __STATIC_CONTENT 和 __STATIC_CONTENT_MANIFEST 是 [site] 配置自动生成的 KV 绑定名
                    ASSET_NAMESPACE: env.__STATIC_CONTENT,
                    ASSET_MANIFEST: env.__STATIC_CONTENT_MANIFEST,
                    // 其他选项，例如缓存控制
                    // 默认情况下，kv-asset-handler 会处理好大部分MIME类型和缓存头
                }
            );
        } catch (e) {
            // 如果请求的静态文件未找到，尝试返回 index.html (SPA 路由的通用 Fallback)
            if (e.message.includes('NOT_FOUND')) {
                console.log('Worker: Static asset not found, trying to serve index.html as fallback');
                try {
                    // 构建一个新的请求，指向 index.html，以便 getAssetFromKV 能够找到它
                    const indexAsset = await getAssetFromKV(
                        { request: new Request(`${url.origin}/index.html`, request), waitUntil: ctx.waitUntil },
                        {
                            ASSET_NAMESPACE: env.__STATIC_CONTENT,
                            ASSET_MANIFEST: env.__STATIC_CONTENT_MANIFEST,
                        }
                    );
                    return indexAsset;
                } catch (indexError) {
                    console.error('Worker: Failed to serve index.html as fallback:', indexError);
                    return new Response('Not Found', { status: 404 });
                }
            }
            console.error('Worker: Error serving static asset:', e);
            return new Response('Internal Error Serving Static Asset', { status: 500 });
        }
    },

    // Worker 的定时任务处理函数
    async scheduled(event, env, ctx) {
        console.log(`Worker: Scheduled event triggered at ${new Date(event.scheduledTime).toISOString()}`);
        await handleScheduledTasks(env);
    }
};


// ==========================================================
// 2. 以下是您提供的所有辅助函数，保持不变或进行小幅修改
// ==========================================================

// 从 KV 命名空间 (GLOBAL_CONFIG) 加载配置
async function loadAppConfig(env) {
  // 修正：根据您的 wrangler.toml，KV 绑定名为 GLOBAL_CONFIG
  // KV 命名空间直接通过 .get(key) 获取值
  // 假设您的配置 JSON 存储在 KV 的一个键中，该键的名称也叫 'GLOBAL_CONFIG'
  const globalConfigText = await env.GLOBAL_CONFIG.get('GLOBAL_CONFIG'); // <--- 关键修正！
  if (!globalConfigText) {
    throw new Error('配置未找到，请先在 KV 命名空间中创建名为 "GLOBAL_CONFIG" 的键');
  }
  return JSON.parse(globalConfigText);
}

// 处理定时任务
async function handleScheduledTasks(env) {
  try {
    const config = await loadAppConfig(env);
    
    // 确保 notification_channels 存在且是对象
    if (!config.notification_channels || typeof config.notification_channels !== 'object') {
      throw new Error('配置中的 notification_channels 必须是对象');
    }
    
    const currentTime = new Date().toISOString();
    const dueTasks = await queryDueTasks(env, currentTime);
    console.log(`Worker: Found ${dueTasks.length} due tasks.`);

    for (const task of dueTasks) {
      let executeResult = { status: 'fail', message: '' };
      const startTime = Date.now(); 
      
      try {
        // 明确声明 channelConfig 的类型
        const channelConfig = config.notification_channels[task.channel];
        if (!channelConfig) {
          throw new Error(`未知推送渠道: ${task.channel}`);
        }
        
        let pushResponse;
        if (task.channel  === 'server_chan') {
          pushResponse = await sendByServerChan(task.content,  channelConfig, { title: task.name  });
        } else if (task.channel  === 'wechat_work') {
          pushResponse = await sendByWechatWork(task.content,  channelConfig, task.channel_config  || {});
        }
        
        executeResult = {
          status: 'success',
          message: `推送成功，渠道响应: ${JSON.stringify(pushResponse)}`
        };
        await updateTaskAfterSuccess(env, task, currentTime);
        
      } catch (error) {
        console.error(`Worker: Task ${task.id} push failed: ${error.message}. Retrying...`);
        let retryCount = 0;
        while (retryCount < config.retry_config.max_retry)  {
          await new Promise(resolve => setTimeout(resolve, config.retry_config.retry_interval)); 
          retryCount++;
          console.log(`Worker: Task ${task.id} retry ${retryCount} of ${config.retry_config.max_retry}`);
          
          try {
            if (task.channel  === 'server_chan') {
              await sendByServerChan(task.content,  channelConfig, { title: task.name  });
            } else if (task.channel  === 'wechat_work') {
              await sendByWechatWork(task.content,  channelConfig, task.channel_config  || {});
            }
            
            executeResult = {
              status: 'success',
              message: `重试 ${retryCount} 次后推送成功`
            };
            await updateTaskAfterSuccess(env, task, currentTime);
            break; // 重试成功，跳出循环
            
          } catch (retryError) {
            if (retryCount >= config.retry_config.max_retry)  {
              executeResult.message  = `推送失败（重试 ${retryCount} 次）: ${retryError.message}`;
            }
          }
        }
      } finally {
        // 无论成功失败，都记录日志
        await insertTaskLog(env, {
          id: crypto.randomUUID(), 
          task_id: task.id, 
          channel: task.channel, 
          execute_time: currentTime,
          status: executeResult.status, 
          message: executeResult.message, 
          duration: Date.now()  - startTime 
        });
      }
    }
  } catch (error) {
    console.error('Worker: 定时任务处理错误:', error);
  }
}

// API 路由处理 
async function handleTaskApi(request, url, env) {
  const method = request.method; 
  // 根据前端的 API 路径，PUT 和 DELETE 使用 `/api/task/{id}`。
  // 您的 handleTaskApi 内部逻辑是 /api/tasks/{id}。
  // 保持一致性，假设前端会调整为 /api/tasks/{id}，或者在此处做兼容性处理。
  // 建议前端统一为 /api/tasks/{id}
  const pathSegments = url.pathname.split('/');
  const taskId = pathSegments[3]; // 对于 /api/tasks/{id}

  if (method === 'POST' && url.pathname  === '/api/tasks') {
    return handleCreateTask(request, env);
  } else if (method === 'GET' && url.pathname  === '/api/tasks') {
    return handleGetTasks(env);
  } else if (method === 'PUT' && url.pathname.startsWith('/api/tasks/') && taskId)  {
    return handleUpdateTask(request, taskId, env);
  } else if (method === 'DELETE' && url.pathname.startsWith('/api/tasks/') && taskId)  {
    return handleDeleteTask(taskId, env);
  }
  return new Response('Not Found', { status: 404 });
}

// 创建任务
async function handleCreateTask(request, env) {
  try {
    const taskData = await request.json(); 
    const requiredFields = ['name', 'content', 'channel', 'execute_time', 'type'];
    const missingFields = requiredFields.filter(field  => !taskData[field]);
    if (missingFields.length  > 0) {
      return new Response(`缺少必填字段: ${missingFields.join(',  ')}`, { status: 400 });
    }
    
    const task = {
      id: crypto.randomUUID(), 
      create_time: new Date().toISOString(),
      update_time: new Date().toISOString(),
      execute_count: 0,
      status: taskData.status  ?? true,
      channel_config: taskData.channel_config  ?? {},
      ...taskData
    };
    
    await insertTask(env, task);
    return new Response(JSON.stringify({  success: true, taskId: task.id  }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
      console.error("Error creating task:", error);
      return new Response(JSON.stringify({ success: false, message: error.message || "Failed to create task" }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
      });
  }
}

// 获取任务列表
async function handleGetTasks(env) {
  try {
    const tasks = await queryAllTasks(env);
    return new Response(JSON.stringify(tasks),  {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
      console.error("Error getting tasks:", error);
      return new Response(JSON.stringify({ success: false, message: error.message || "Failed to retrieve tasks" }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
      });
  }
}

// 更新任务
async function handleUpdateTask(request, taskId, env) {
  try {
    const taskData = await request.json(); 
    const task = await getTaskById(env, taskId);
    if (!task) {
      return new Response('任务不存在', { status: 404 });
    }
    const updatedTask = {
      ...task,
      ...taskData,
      update_time: new Date().toISOString()
    };
    await updateTask(env, updatedTask);
    return new Response(JSON.stringify({  success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
      console.error("Error updating task:", error);
      return new Response(JSON.stringify({ success: false, message: error.message || "Failed to update task" }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
      });
  }
}

// 删除任务
async function handleDeleteTask(taskId, env) {
  try {
    await deleteTask(env, taskId);
    return new Response(JSON.stringify({  success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
      console.error("Error deleting task:", error);
      return new Response(JSON.stringify({ success: false, message: error.message || "Failed to delete task" }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
      });
  }
}

// 查询到期任务
async function queryDueTasks(env, currentTime) {
  const { results } = await env.DB.prepare( 
    "SELECT * FROM task WHERE status = TRUE AND execute_time <= ? ORDER BY execute_time ASC"
  ).bind(currentTime).all();
  return results;
}

// 查询所有任务
async function queryAllTasks(env) {
  const { results } = await env.DB.prepare("SELECT  * FROM task").all();
  return results;
}

// 插入任务
async function insertTask(env, task) {
  await env.DB.prepare( 
    "INSERT INTO task (id, name, content, channel, channel_config, status, type, execute_time, cycle_config, create_time, update_time, execute_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind([
    task.id, 
    task.name, 
    task.content, 
    task.channel, 
    JSON.stringify(task.channel_config), // channel_config 存储为 JSON 字符串
    task.status, 
    task.type, 
    task.execute_time, 
    JSON.stringify(task.cycle_config), // cycle_config 存储为 JSON 字符串
    task.create_time, 
    task.update_time, 
    task.execute_count 
  ]).run();
}

// 更新任务
async function updateTask(env, task) {
  await env.DB.prepare( 
    "UPDATE task SET name = ?, content = ?, channel = ?, channel_config = ?, status = ?, type = ?, execute_time = ?, cycle_config = ?, update_time = ?, execute_count = ? WHERE id = ?"
  ).bind([
    task.name, 
    task.content, 
    task.channel, 
    JSON.stringify(task.channel_config), 
    task.status, 
    task.type, 
    task.execute_time, 
    JSON.stringify(task.cycle_config), 
    task.update_time, 
    task.execute_count, 
    task.id  
  ]).run();
}

// 删除任务
async function deleteTask(env, taskId) {
  await env.DB.prepare("DELETE  FROM task WHERE id = ?").bind(taskId).run();
}

// 获取单个任务
async function getTaskById(env, taskId) {
  const { results } = await env.DB.prepare("SELECT  * FROM task WHERE id = ?").bind(taskId).all();
  return results[0] || null;
}

// 更新任务状态（用于周期任务）
async function updateTaskAfterSuccess(env, task, currentTime) {
  let nextExecuteTime = task.execute_time; 
  if (task.type  === 'single') {
    task.status  = false;
  } else if (task.type  === 'cycle') {
    const period = task.cycle_config?.period; 
    const endDate = task.cycle_config?.end_time; 
    if (endDate && new Date(endDate) <= new Date(currentTime)) {
      task.status  = false;
    } else {
      const current = new Date(currentTime);
      switch (period) {
        case 'day':
          // 确保日期计算正确，避免时区问题
          current.setDate(current.getDate() + 1);
          nextExecuteTime = current.toISOString();
          break;
        case 'week':
          current.setDate(current.getDate() + 7);
          nextExecuteTime = current.toISOString();
          break;
        case 'month':
          current.setMonth(current.getMonth() + 1);
          nextExecuteTime = current.toISOString();
          break;
        default:
          break;
      }
    }
  }
  task.execute_count  += 1;
  task.update_time  = currentTime;
  task.execute_time  = nextExecuteTime; // 更新下次执行时间
  await updateTask(env, task);
}

// 插入任务日志
async function insertTaskLog(env, log) {
  await env.DB.prepare( 
    "INSERT INTO log (id, task_id, channel, execute_time, status, message, duration) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind([
    log.id, 
    log.task_id, 
    log.channel, 
    log.execute_time, 
    log.status, 
    log.message, 
    log.duration 
  ]).run();
}

// ServerChan 推送
async function sendByServerChan(content, channelConfig, options = {}) {
  const { send_key, api_prefix } = channelConfig;
  if (!send_key) throw new Error('ServerChan 推送失败: 缺少 send_key');
  let pushUrl;
  if (send_key.startsWith('sctp'))  {
    const matchResult = /sctp(\d+)/.exec(send_key);
    if (!matchResult) throw new Error('ServerChan 推送失败: 无效的 sctp 格式 send_key');
    const serverNum = matchResult[1];
    pushUrl = `https://${serverNum}.push.ft07.com/send/${send_key}.send`; 
  } else {
    pushUrl = `${api_prefix}${send_key}.send`;
  }
  const requestParams = {
    title: options.title  || '定时消息推送',
    desp: content,
    ...options
  };
  const response = await fetch(pushUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify(requestParams) 
  });
  const responseData = await response.json(); 
  if (responseData.code  !== 0) {
    throw new Error(`ServerChan 推送失败: ${responseData.message  || '未知错误'}`);
  }
  return responseData;
}

// WeChatWork 推送
async function sendByWechatWork(content, channelConfig, taskChannelConfig = {}) {
  const { corp_id, app_secret, agent_id, default_receiver } = channelConfig;
  if (!corp_id || !app_secret || !agent_id) {
    throw new Error('WeChatWork 推送失败: 缺少 corp_id/app_secret/agent_id');
  }
  const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corp_id}&corpsecret=${app_secret}`; 
  const tokenResponse = await fetch(tokenUrl);
  const tokenData = await tokenResponse.json(); 
  if (tokenData.errcode  !== 0) {
    throw new Error(`WeChatWork 获取 token 失败: ${tokenData.errmsg}`); 
  }
  const accessToken = tokenData.access_token; 
  const receiver = { ...default_receiver, ...taskChannelConfig };
  const pushUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`; 
  const requestData = {
    touser: receiver.touser  || '@all',
    toparty: receiver.toparty  || '',
    totag: receiver.totag  || '',
    msgtype: 'textcard',
    agentid: parseInt(agent_id),
    textcard: {
      title: '定时消息提醒',
      description: content,
      url: 'https://example.com/task-detail', // 您可以替换为实际的任务详情页URL
      btntxt: '查看详情'
    },
    safe: 0 
  };
  const response = await fetch(pushUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify(requestData) 
  });
  const pushData = await response.json(); 
  if (pushData.errcode  !== 0) {
    throw new Error(`WeChatWork 推送失败: ${pushData.errmsg}`); 
  }
  return pushData;
}
