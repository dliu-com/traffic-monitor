import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ADDED_COLUMNS, LOG_COLUMNS, TrafficMonitorStack } from '../lib/traffic-monitor-stack';
import { RECORD_FIELDS, TrafficLogDeliveryStack } from '../lib/log-delivery-stack';

const template = Template.fromStack(new TrafficMonitorStack(new App(), 'TrafficMonitor', {
  sites: [{ key: 'root', host: 'dliu.com' }, { key: 'cyy', host: 'cyy.dliu.com' }],
  env: { account: '123456789012', region: 'eu-west-1' },
}));

test('log bucket allows CloudFront ACL-based delivery and expires logs after a year', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerPreferred' }] },
    LifecycleConfiguration: {
      Rules: Match.arrayWith([
        Match.objectLike({ Prefix: 'logs/', ExpirationInDays: 365 }),
        Match.objectLike({ Prefix: 'raw/', ExpirationInDays: 7 }),
        Match.objectLike({ Prefix: 'raw-v2/', ExpirationInDays: 7 }),
      ]),
    },
  });
});

test('exports the log bucket and visitor function for the sites', () => {
  template.hasOutput('TrafficLogBucketName', { Export: { Name: 'TrafficLogBucketName' } });
  template.hasOutput('TrafficVisitorFunctionArn', { Export: { Name: 'TrafficVisitorFunctionArn' } });
});

test('visitor function is a named cloudfront-js-2.0 function', () => {
  template.hasResourceProperties('AWS::CloudFront::Function', {
    Name: 'dliu-visitor-id',
    FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0' }),
  });
});

test('glue table uses partition projection over site and day', () => {
  template.hasResourceProperties('AWS::Glue::Table', {
    TableInput: Match.objectLike({
      Name: 'cloudfront_logs',
      PartitionKeys: [{ Name: 'site', Type: 'string' }, { Name: 'dt', Type: 'string' }],
      Parameters: Match.objectLike({
        'projection.enabled': 'true',
        'projection.site.values': 'root,cyy',
        'skip.header.line.count': '2',
      }),
    }),
  });
  expect(LOG_COLUMNS).toHaveLength(33);
  expect(ADDED_COLUMNS.map(([name]) => name)).toEqual(['c_country', 'asn', 'vid_log']);
  template.hasResourceProperties('AWS::Glue::Table', {
    TableInput: Match.objectLike({
      StorageDescriptor: Match.objectLike({
        Columns: Match.arrayWith([
          { Name: 'sc_range_end', Type: 'bigint' },
          { Name: 'c_country', Type: 'string' },
          { Name: 'asn', Type: 'string' },
          { Name: 'vid_log', Type: 'string' },
        ]),
      }),
    }),
  });
});

test('glue columns line up with the requested v2 log fields', () => {
  expect(RECORD_FIELDS).toHaveLength(LOG_COLUMNS.length + ADDED_COLUMNS.length);
  const normalise = (name: string) => name.toLowerCase().replace(/[()-]/g, '_').replace(/_+$/, '');
  const expected = [...LOG_COLUMNS, ...ADDED_COLUMNS].map(([name]) => name);
  const renamed: Record<string, string> = { cs_referer: 'cs_referrer', viewer_response_log_data: 'vid_log' };
  expect(RECORD_FIELDS.map(normalise).map((n) => renamed[n] ?? n)).toEqual(expected);
});

test('log delivery service can only write raw-v2/ for this account', () => {
  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Sid: 'AWSLogDeliveryWrite',
          Principal: { Service: 'delivery.logs.amazonaws.com' },
          Action: 's3:PutObject',
          Condition: {
            StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control', 'aws:SourceAccount': '123456789012' },
            ArnLike: { 'aws:SourceArn': 'arn:aws:logs:us-east-1:123456789012:delivery-source:*' },
          },
        }),
      ]),
    },
  });
  const policy = JSON.stringify(template.findResources('AWS::S3::BucketPolicy'));
  expect(policy).toContain('/raw-v2/*');
  template.hasResourceProperties('Custom::S3BucketNotifications', {
    NotificationConfiguration: {
      LambdaFunctionConfigurations: [
        Match.objectLike({ Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'raw/' }] } } }),
        Match.objectLike({ Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'raw-v2/' }] } } }),
      ],
    },
  });
});

describe('log delivery stack', () => {
  const delivery = Template.fromStack(new TrafficLogDeliveryStack(new App(), 'TrafficLogDelivery', {
    logBucketName: 'example-log-bucket',
    sites: [{ key: 'root', distributionId: 'E1EXAMPLE' }, { key: 'cyy', distributionId: 'E2EXAMPLE' }],
    env: { account: '123456789012', region: 'us-east-1' },
  }));

  test('delivers each distribution to raw-v2/<site>/ with country, ASN and visitor ID', () => {
    delivery.hasResourceProperties('AWS::Logs::DeliveryDestination', {
      DestinationResourceArn: 'arn:aws:s3:::example-log-bucket/raw-v2',
      OutputFormat: 'w3c',
    });
    delivery.resourceCountIs('AWS::Logs::DeliverySource', 2);
    delivery.hasResourceProperties('AWS::Logs::DeliverySource', {
      Name: 'traffic-root',
      ResourceArn: 'arn:aws:cloudfront::123456789012:distribution/E1EXAMPLE',
      LogType: 'ACCESS_LOGS',
    });
    delivery.hasResourceProperties('AWS::Logs::Delivery', {
      DeliverySourceName: 'traffic-cyy',
      S3SuffixPath: 'cyy/{yyyy}/{MM}/{dd}',
      FieldDelimiter: '\t',
      RecordFields: Match.arrayWith(['c-ip', 'cs(Cookie)', 'c-country', 'asn', 'viewer-response-log-data']),
    });
  });

  test('refuses other regions and bad site config', () => {
    expect(() => new TrafficLogDeliveryStack(new App(), 'X', {
      logBucketName: 'b', sites: [], env: { account: '123456789012', region: 'eu-west-1' },
    })).toThrow(/us-east-1/);
    expect(() => new TrafficLogDeliveryStack(new App(), 'Y', {
      logBucketName: 'b', sites: [{ key: 'Bad Key', distributionId: 'E1EXAMPLE' }], env: { account: '123456789012', region: 'us-east-1' },
    })).toThrow(/Invalid site/);
  });
});

test('athena workgroup enforces a scan limit', () => {
  template.hasResourceProperties('AWS::Athena::WorkGroup', {
    Name: 'traffic',
    WorkGroupConfiguration: Match.objectLike({ EnforceWorkGroupConfiguration: true, BytesScannedCutoffPerQuery: 1073741824 }),
  });
});

test('dashboard routes api and auth to the Lambda without caching', () => {
  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      CacheBehaviors: Match.arrayWith([
        Match.objectLike({ PathPattern: 'api/*', CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad' }),
        Match.objectLike({ PathPattern: 'auth/*', CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad' }),
      ]),
    }),
  });
  template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
});

test('dashboard sends security headers and serves clean info-page URLs', () => {
  template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
    ResponseHeadersPolicyConfig: Match.objectLike({
      SecurityHeadersConfig: Match.objectLike({
        ContentSecurityPolicy: Match.objectLike({ ContentSecurityPolicy: Match.stringLikeRegexp("script-src 'self';.*frame-ancestors 'none'") }),
        FrameOptions: Match.objectLike({ FrameOption: 'DENY' }),
      }),
      CustomHeadersConfig: { Items: Match.arrayWith([Match.objectLike({ Header: 'Permissions-Policy' }), Match.objectLike({ Header: 'Cross-Origin-Opener-Policy', Value: 'same-origin' })]) },
    }),
  });
  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      DefaultCacheBehavior: Match.objectLike({ FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })] }),
    }),
  });
});

test('dashboard Lambda can only read its own SSM parameters', () => {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'ssm:GetParameters',
          Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':ssm:eu-west-1:123456789012:parameter/traffic-monitor/*']] },
        }),
      ]),
    },
  });
});
