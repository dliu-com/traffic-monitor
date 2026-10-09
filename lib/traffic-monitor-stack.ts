import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';
import {
  aws_athena as athena,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_glue as glue,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_s3_notifications as s3n,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib';

const ROOT = path.join(__dirname, '..');

export const GLUE_DATABASE = 'traffic';
export const GLUE_TABLE = 'cloudfront_logs';
export const ATHENA_WORKGROUP = 'traffic';
export const PARAMETER_PREFIX = '/traffic-monitor';
export const VISITOR_FUNCTION_NAME = 'dliu-visitor-id';

// CloudFront standard (legacy) access log fields, in file order.
export const LOG_COLUMNS: Array<[string, string]> = [
  ['date', 'date'], ['time', 'string'], ['x_edge_location', 'string'], ['sc_bytes', 'bigint'],
  ['c_ip', 'string'], ['cs_method', 'string'], ['cs_host', 'string'], ['cs_uri_stem', 'string'],
  ['sc_status', 'int'], ['cs_referrer', 'string'], ['cs_user_agent', 'string'], ['cs_uri_query', 'string'],
  ['cs_cookie', 'string'], ['x_edge_result_type', 'string'], ['x_edge_request_id', 'string'], ['x_host_header', 'string'],
  ['cs_protocol', 'string'], ['cs_bytes', 'bigint'], ['time_taken', 'float'], ['x_forwarded_for', 'string'],
  ['ssl_protocol', 'string'], ['ssl_cipher', 'string'], ['x_edge_response_result_type', 'string'], ['cs_protocol_version', 'string'],
  ['fle_status', 'string'], ['fle_encrypted_fields', 'int'], ['c_port', 'int'], ['time_to_first_byte', 'float'],
  ['x_edge_detailed_result_type', 'string'], ['sc_content_type', 'string'], ['sc_content_len', 'bigint'],
  ['sc_range_start', 'bigint'], ['sc_range_end', 'bigint'],
];

export interface TrafficMonitorStackProps extends StackProps {
  /** Site keys used as log prefixes (raw/<key>/) and Athena partitions. */
  sites: string[];
  /** Subdomain for the dashboard, under the MainDomain export. */
  dashboardSubdomain?: string;
  /** Raw log retention. */
  retentionDays?: number;
}

export class TrafficMonitorStack extends Stack {
  constructor(scope: Construct, id: string, props: TrafficMonitorStackProps) {
    super(scope, id, props);

    const subdomain = props.dashboardSubdomain ?? 'traffic';
    const rootDomain = Fn.importValue('MainDomain');
    const domainName = Fn.join('', [`${subdomain}.`, rootDomain]);
    const siteUrl = Fn.join('', ['https://', domainName]);
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'ImportedHostedZone', {
      zoneName: rootDomain,
      hostedZoneId: Fn.importValue('MainHostedZoneId'),
    });

    // ---------- Log storage ----------
    // CloudFront standard logging writes with ACLs, so ownership cannot be BucketOwnerEnforced.
    const logBucket = new s3.Bucket(this, 'LogBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { id: 'expire-logs', prefix: 'logs/', expiration: Duration.days(props.retentionDays ?? 365) },
        { id: 'expire-unprocessed-raw', prefix: 'raw/', expiration: Duration.days(7) },
        { id: 'abort-multipart', abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
    });

    const partitioner = new lambda.Function(this, 'LogPartitioner', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(ROOT, 'lambda/partitioner')),
      timeout: Duration.seconds(60),
      memorySize: 256,
      description: 'Moves CloudFront log files from raw/<site>/ into logs/site=<site>/dt=<day>/',
      logGroup: new logs.LogGroup(this, 'LogPartitionerLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    logBucket.grantRead(partitioner, 'raw/*');
    logBucket.grantDelete(partitioner, 'raw/*');
    logBucket.grantPut(partitioner, 'logs/*');
    logBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(partitioner), { prefix: 'raw/' });

    // ---------- Visitor cookie (attached by each site at viewer-response) ----------
    const visitorCode = fs.readFileSync(path.join(ROOT, 'functions/visitor-id.js'), 'utf8')
      .replace(/__COOKIE_DOMAIN__/g, () => rootDomain);
    const visitorFunction = new cloudfront.Function(this, 'VisitorIdFunction', {
      functionName: VISITOR_FUNCTION_NAME,
      comment: 'Sets the dl_vid visitor cookie for traffic monitoring',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(visitorCode),
    });

    // ---------- Query layer ----------
    const resultsBucket = new s3.Bucket(this, 'AthenaResults', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: Duration.days(7) }],
    });

    const database = new glue.CfnDatabase(this, 'Database', {
      catalogId: this.account,
      databaseInput: { name: GLUE_DATABASE, description: 'Traffic logs for the dliu.com CloudFront sites' },
    });

    const table = new glue.CfnTable(this, 'LogsTable', {
      catalogId: this.account,
      databaseName: GLUE_DATABASE,
      tableInput: {
        name: GLUE_TABLE,
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          'skip.header.line.count': '2',
          'projection.enabled': 'true',
          'projection.site.type': 'enum',
          'projection.site.values': props.sites.join(','),
          'projection.dt.type': 'date',
          'projection.dt.format': 'yyyy-MM-dd',
          'projection.dt.range': '2026-01-01,NOW',
          'projection.dt.interval': '1',
          'projection.dt.interval.unit': 'DAYS',
          'storage.location.template': `s3://${logBucket.bucketName}/logs/site=` + '${site}/dt=${dt}/',
        },
        partitionKeys: [
          { name: 'site', type: 'string' },
          { name: 'dt', type: 'string' },
        ],
        storageDescriptor: {
          location: `s3://${logBucket.bucketName}/logs/`,
          columns: LOG_COLUMNS.map(([name, type]) => ({ name, type })),
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
            parameters: { 'field.delim': '\t', 'serialization.format': '\t' },
          },
        },
      },
    });
    table.addResourceDependency(database);

    const workGroup = new athena.CfnWorkGroup(this, 'WorkGroup', {
      name: ATHENA_WORKGROUP,
      description: 'Traffic dashboard queries',
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: false,
        bytesScannedCutoffPerQuery: 1024 * 1024 * 1024,
        engineVersion: { selectedEngineVersion: 'AUTO' },
        resultConfiguration: {
          outputLocation: `s3://${resultsBucket.bucketName}/results/`,
          encryptionConfiguration: { encryptionOption: 'SSE_S3' },
        },
      },
    });

    // ---------- Dashboard ----------
    const dashboardHandler = new lambda.Function(this, 'DashboardHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(ROOT, 'lambda/dashboard')),
      timeout: Duration.seconds(30),
      memorySize: 512,
      description: 'traffic dashboard API and Microsoft Entra sign-in',
      environment: {
        SITE_URL: siteUrl,
        ROOT_DOMAIN: rootDomain,
        SITES: props.sites.join(','),
        GLUE_DATABASE,
        GLUE_TABLE,
        ATHENA_WORKGROUP,
        PARAMETER_PREFIX,
      },
      logGroup: new logs.LogGroup(this, 'DashboardLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    const workGroupArn = this.formatArn({ service: 'athena', resource: 'workgroup', resourceName: ATHENA_WORKGROUP });
    dashboardHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults', 'athena:StopQueryExecution'],
      resources: [workGroupArn],
    }));
    dashboardHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetPartition', 'glue:GetPartitions'],
      resources: [
        this.formatArn({ service: 'glue', resource: 'catalog' }),
        this.formatArn({ service: 'glue', resource: 'database', resourceName: GLUE_DATABASE }),
        this.formatArn({ service: 'glue', resource: 'table', resourceName: `${GLUE_DATABASE}/${GLUE_TABLE}` }),
      ],
    }));
    dashboardHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters'],
      resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: PARAMETER_PREFIX.slice(1) + '/*' })],
    }));
    dashboardHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
    }));
    logBucket.grantRead(dashboardHandler, 'logs/*');
    resultsBucket.grantReadWrite(dashboardHandler);

    const functionUrl = dashboardHandler.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    const siteBucket = new s3.Bucket(this, 'DashboardBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront requires its certificate in us-east-1 (same pattern as the other sites).
    const certificate = new acm.DnsValidatedCertificate(this, 'DashboardCertificate', {
      domainName,
      hostedZone,
      region: 'us-east-1',
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, 'DashboardHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://files.dliu.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [{ header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true }],
      },
    });

    const lambdaBehavior: cloudfront.BehaviorOptions = {
      origin: origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl, { readTimeout: Duration.seconds(30) }),
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: headers,
    };

    const distribution = new cloudfront.Distribution(this, 'DashboardDistribution', {
      comment: 'traffic dashboard',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
      },
      additionalBehaviors: {
        'api/*': lambdaBehavior,
        'auth/*': lambdaBehavior,
      },
      domainNames: [domainName],
      certificate,
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // New function URLs require both invoke permissions. CDK adds InvokeFunctionUrl.
    dashboardHandler.addPermission('CloudFrontInvokeFunction', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: distribution.distributionArn,
      invokedViaFunctionUrl: true,
    });

    new s3deploy.BucketDeployment(this, 'DashboardContent', {
      sources: [s3deploy.Source.asset(path.join(ROOT, 'web'))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    new route53.ARecord(this, 'DashboardAliasRecord', {
      recordName: subdomain,
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });
    new route53.AaaaRecord(this, 'DashboardAliasIpv6Record', {
      recordName: subdomain,
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    // ---------- Exports consumed by the site stacks ----------
    new CfnOutput(this, 'TrafficLogBucketName', {
      value: logBucket.bucketName,
      exportName: 'TrafficLogBucketName',
      description: 'Bucket for CloudFront standard logs. Sites log to raw/<site>/ with cookies included.',
    });
    new CfnOutput(this, 'TrafficVisitorFunctionArn', {
      value: visitorFunction.functionArn,
      exportName: 'TrafficVisitorFunctionArn',
      description: 'CloudFront Function to attach at viewer-response on each site default behavior.',
    });
    new CfnOutput(this, 'DashboardUrl', { value: siteUrl });
    new CfnOutput(this, 'AuthRedirectUri', { value: Fn.join('', [siteUrl, '/auth/callback']) });
    new CfnOutput(this, 'AthenaWorkGroup', { value: workGroup.name });
    new CfnOutput(this, 'DashboardFunctionName', { value: dashboardHandler.functionName });
  }
}
