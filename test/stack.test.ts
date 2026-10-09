import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { LOG_COLUMNS, TrafficMonitorStack } from '../lib/traffic-monitor-stack';

const template = Template.fromStack(new TrafficMonitorStack(new App(), 'TrafficMonitor', {
  sites: ['root', 'cyy'],
  env: { account: '123456789012', region: 'eu-west-1' },
}));

test('log bucket allows CloudFront ACL-based delivery and expires logs after a year', () => {
  template.hasResourceProperties('AWS::S3::Bucket', {
    OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerPreferred' }] },
    LifecycleConfiguration: {
      Rules: Match.arrayWith([
        Match.objectLike({ Prefix: 'logs/', ExpirationInDays: 365 }),
        Match.objectLike({ Prefix: 'raw/', ExpirationInDays: 7 }),
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
