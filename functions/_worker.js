// functions/_worker.js

// 保持 scheduled 函数不变，用于定时任务触发
export async function scheduled(event, env, ctx) {
  await handleScheduledTasks(env);
}

// 将原 worker.mjs 中的 fetch 函数改为 onRequest
export async function onRequest(context) {
  // context 对象包含了 request, env, next, params 等信息
  const { request, env, next } = context;
  const url = new URL(request.url);

  // 检查请求路径是否是 API 路径
  if (url.pathname.startsWith('/api/task')) {
    // 如果是 API 请求，调用您的 API 处理函数
    return handleTaskApi(request, url, env);
  }

  // 如果不是 API 请求（例如对 index.html 的请求），
  // 则调用 next() 让 Pages 继续处理静态文件服务。
  return next();
}


// 从 Secrets Store 加载配置
async function loadAppConfig(env) {
  // ... (您的 loadAppConfig 函数代码，保持不变) ...
  const secrets = await env.SECRETS_STORE.list();
  const globalConfig = secrets.find(s  => s.name  === 'GLOBAL_CONFIG');
  if (!globalConfig) {
    throw new Error('配置未找到，请先在 Secrets Store 中创建 GLOBAL_CONFIG');
  }
  return JSON.parse(globalConfig.text);
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
        let retryCount = 0;
        while (retryCount < config.retry_config.max_retry)  {
          await new Promise(resolve => setTimeout(resolve, config.retry_config.retry_interval)); 
          retryCount++;
          
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
            break;
            
          } catch (retryError) {
            if (retryCount >= config.retry_config.max_retry)  {
              executeResult.message  = `推送失败（重试 ${retryCount} 次）: ${retryError.message}`;
            }
          }
        }
      } finally {
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
    console.error(' 定时任务处理错误:', error);
  }
}

// API 路由处理 
async function handleTaskApi(request, url, env) {
  const method = request.method; 
  if (method === 'POST' && url.pathname  === '/api/task') {
    return handleCreateTask(request, env);
  } else if (method === 'GET' && url.pathname  === '/api/tasks') {
    return handleGetTasks(env);
  } else if (method === 'PUT' && url.pathname.startsWith('/api/task/'))  {
    const taskId = url.pathname.split('/')[3]; 
    return handleUpdateTask(request, taskId, env);
  } else if (method === 'DELETE' && url.pathname.startsWith('/api/task/'))  {
    const taskId = url.pathname.split('/')[3]; 
    return handleDeleteTask(taskId, env);
  }
  return new Response('Not Found', { status: 404 });
}

// 创建任务
async function handleCreateTask(request, env) {
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
}

// 获取任务列表
async function handleGetTasks(env) {
  const tasks = await queryAllTasks(env);
  return new Response(JSON.stringify(tasks),  {
    headers: { 'Content-Type': 'application/json' }
  });
}

// 更新任务
async function handleUpdateTask(request, taskId, env) {
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
}

// 删除任务
async function handleDeleteTask(taskId, env) {
  await deleteTask(env, taskId);
  return new Response(JSON.stringify({  success: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
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
    "INSERT INTO task (id, name, content, channel, channel_config, status, type, execute_time, cycle_config, create_time, update_time, execute_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind([
    task.id, 
    task.name, 
    task.content, 
    task.channel, 
    JSON.stringify(task.channel_config), 
    task.status, 
    task.type, 
    task.execute_time, 
    JSON.stringify(task.cycle_config), 
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
          nextExecuteTime = new Date(current.setDate(current.getDate()  + 1)).toISOString();
          break;
        case 'week':
          nextExecuteTime = new Date(current.setDate(current.getDate()  + 7)).toISOString();
          break;
        case 'month':
          nextExecuteTime = new Date(current.setMonth(current.getMonth()  + 1)).toISOString();
          break;
        default:
          break;
      }
    }
  }
  task.execute_count  += 1;
  task.update_time  = currentTime;
  task.execute_time  = nextExecuteTime;
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
      url: 'https://example.com/task-detail', 
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