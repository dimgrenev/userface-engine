import { loadKeytarModule } from './optionalDeps';

const SERVICE_NAME = 'userface-engine';
const ACCOUNT_NAME = 'default-user';

export async function storeToken(token: string): Promise<void> {
  const keytar = loadKeytarModule();
  await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, token);
}

export async function getToken(): Promise<string | null> {
  const keytar = loadKeytarModule();
  return await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
}

export async function deleteToken(): Promise<boolean> {
  const keytar = loadKeytarModule();
  return await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
}
