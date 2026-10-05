import { createRequire } from 'node:module';
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMastServer } from '../server.js';

const require = createRequire(import.meta.url);
const manifest = require('../../../package.json') as { version: string };

// Drives the real `initialize` handshake: what a client is told is the contract,
// not the constant the server happens to hold.
describe('MCP server identity — initialize handshake', () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  async function connect(): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'identity-test', version: '0.0.0' }, { capabilities: {} });
    clients.push(client);
    await createMastServer().connect(serverSide);
    await client.connect(clientSide);
    return client;
  }

  it('reports the package.json version as the server version', async () => {
    const client = await connect();

    expect(client.getServerVersion()?.version).toBe(manifest.version);
  });

  it('sends instructions that point the agent at mast_search', async () => {
    const client = await connect();

    expect(client.getInstructions() ?? '').toContain('mast_search');
  });
});
