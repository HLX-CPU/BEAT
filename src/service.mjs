// 服务进程入口（由 client.ensureService 在后台拉起，日志写 data/logs/service.log）。
import { startServer } from './server.mjs';

try {
  const { port } = await startServer();
  console.log(`${new Date().toISOString()} BEAT 已启动：http://127.0.0.1:${port}`);
} catch (e) {
  console.error(e.code === 'EADDRINUSE' ? '端口已被占用（BEAT 可能已在运行）' : e.message);
  process.exit(1);
}
