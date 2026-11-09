import app from './app';
import { mailEnabled } from './lib/mailer';

const PORT = Number(process.env.PORT) || 3001;

app.listen(PORT, () => {
  console.log(`[AIOrc] Server running at http://localhost:${PORT}`);
  console.log(`[AIOrc] MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`[AIOrc] Email notifications: ${mailEnabled ? 'enabled' : 'disabled (create .mail-config.json to enable)'}`);
});
