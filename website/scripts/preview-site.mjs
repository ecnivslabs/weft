import { resolve } from 'node:path';
import { createStaticServer } from './static-server.mjs';

const server = createStaticServer(resolve(import.meta.dirname, '../dist'));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(8000, '127.0.0.1', () => console.log('weft preview: http://127.0.0.1:8000'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
