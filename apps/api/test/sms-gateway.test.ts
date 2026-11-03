import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createNaloGateway } from '../src/lib/sms.js';

const CLIENT_URL = 'https://sms.nalosolutions.com/smsbackend/clientapi/Resl_Nalo/send-message/';
const POST_URL = 'https://sms.nalosolutions.com/smsbackend/Resl_Nalo/send-message/';

const gatewayFor = (url: string | undefined, reply: { body: string; status?: number } | Error) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (reply instanceof Error) throw reply;
    return new Response(reply.body, { status: reply.status ?? 200 });
  }) as typeof fetch;
  const config = loadConfig({ NODE_ENV: 'test', ...(url ? { SMS_API_URL: url, SMS_API_KEY: 'secret-key' } : {}), SMS_SENDER_ID: 'Ninas Wash' });
  return { gateway: createNaloGateway(config, fakeFetch), calls };
};

describe('the Nalo gateway', () => {
  it('is not configured without an address and key, and sends nothing', async () => {
    const { gateway, calls } = gatewayFor(undefined, { body: '' });
    expect(gateway.configured).toBe(false);
    expect((await gateway.send('233245510932', 'Hi')).status).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('sends to a /clientapi/ address as a GET with the details in the web address', async () => {
    const { gateway, calls } = gatewayFor(CLIENT_URL, { body: '1701|233245510932|abc123' });
    const result = await gateway.send('233245510932', "Hi Kofi, it's ready.");
    expect(result).toEqual({ status: 'sent', code: '1701', ref: 'abc123', error: null });
    const sent = new URL(calls[0]!.url);
    expect(calls[0]!.init?.method).toBe('GET');
    expect(sent.origin + sent.pathname).toBe(CLIENT_URL);
    expect(Object.fromEntries(sent.searchParams)).toEqual({
      key: 'secret-key',
      type: '0',
      destination: '233245510932',
      dlr: '1',
      source: 'Ninas Wash',
      message: "Hi Kofi, it's ready.",
    });
  });

  it('sends to any other address as a JSON post', async () => {
    const { gateway, calls } = gatewayFor(POST_URL, { body: JSON.stringify({ status: '1701', job_id: 'job-9', msisdn: '233245510932' }) });
    const result = await gateway.send('233245510932', 'Hi');
    expect(result).toMatchObject({ status: 'sent', code: '1701', ref: 'job-9' });
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ key: 'secret-key', msisdn: '233245510932', message: 'Hi', sender_id: 'Ninas Wash' });
  });

  it('turns Nalo error codes into plain words, from either kind of answer', async () => {
    const bare = await gatewayFor(CLIENT_URL, { body: '1707' }).gateway.send('233245510932', 'Hi');
    expect(bare).toMatchObject({ status: 'failed', code: '1707' });
    expect(bare.error).toContain('sender name');
    // What Nalo really sends back for a bad number.
    const colon = await gatewayFor(CLIENT_URL, { body: '1706:Invalid Destination' }).gateway.send('233000000000', 'Hi');
    expect(colon).toMatchObject({ status: 'failed', code: '1706' });
    expect(colon.error).toContain('not valid');
    const json = await gatewayFor(POST_URL, { body: JSON.stringify({ status: '1025' }) }).gateway.send('233245510932', 'Hi');
    expect(json).toMatchObject({ status: 'failed', code: '1025' });
    expect(json.error).toContain('credit');
  });

  it('reports a network failure or a nonsense answer instead of throwing', async () => {
    const down = await gatewayFor(CLIENT_URL, new Error('offline')).gateway.send('233245510932', 'Hi');
    expect(down).toMatchObject({ status: 'failed', code: null });
    const odd = await gatewayFor(CLIENT_URL, { body: '<html>oops</html>', status: 502 }).gateway.send('233245510932', 'Hi');
    expect(odd).toMatchObject({ status: 'failed', code: null });
    expect(odd.error).toContain('502');
  });
});
