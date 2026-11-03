const { loadConfig, resetConfigCache, NotConfigured, PARAMETERS } = require('../lambda/dashboard/config');

const TENANT = '11111111-2222-3333-4444-555555555555';

function ssmWith(values) {
  const send = jest.fn(async (command) => ({
    Parameters: command.input.Names.filter((name) => values[name]).map((name) => ({ Name: name, Value: values[name] })),
  }));
  return { send };
}

describe('dashboard config', () => {
  beforeEach(() => resetConfigCache());

  test('reads the shared tenant ID and this app\'s own client settings in one call', async () => {
    const ssm = ssmWith({
      '/dliu/entra-tenant-id': ` ${TENANT}\n`,
      '/traffic-monitor/entra-client-id': 'client-id',
      '/traffic-monitor/entra-client-secret': 'secret-value',
    });
    const config = await loadConfig(ssm, 1000);
    expect(ssm.send).toHaveBeenCalledTimes(1);
    expect(ssm.send.mock.calls[0][0].input).toEqual({
      Names: ['/dliu/entra-tenant-id', '/traffic-monitor/entra-client-id', '/traffic-monitor/entra-client-secret'],
      WithDecryption: true,
    });
    expect(config).toMatchObject({ tenantId: TENANT, clientId: 'client-id', clientSecret: 'secret-value' });
    expect(PARAMETERS.tenantId).toBe('/dliu/entra-tenant-id');
  });

  test('ignores the old per-app tenant parameter and names what is missing', async () => {
    const ssm = ssmWith({
      '/traffic-monitor/entra-tenant-id': TENANT,
      '/traffic-monitor/entra-client-id': 'client-id',
      '/traffic-monitor/entra-client-secret': 'secret-value',
    });
    await expect(loadConfig(ssm, 1000)).rejects.toThrow(NotConfigured);
    await expect(loadConfig(ssm, 1000)).rejects.toThrow('/dliu/entra-tenant-id');
  });
});
