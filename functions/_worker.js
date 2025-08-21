export async function onRequest(context) {
    const { request, env } = context; // 这里我们不再需要 `next`，因为我们不打算将请求传递给静态文件服务
    const url = new URL(request.url);

    console.log('SUPER DEBUG MODE: Intercepted ANY request:', url.pathname, 'Method:', request.method);

    // 无论请求什么路径，都返回一个固定的 JSON 响应
    return new Response(JSON.stringify({
        message: "Hello from Pages Function - SUPER DEBUG MODE!",
        requestedPath: url.pathname,
        requestMethod: request.method,
        timestamp: new Date().toISOString()
    }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}