import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';
import {
  aws_athena as athena,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_events as events,
  aws_events_targets as eventTargets,
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
export const GLUE_ARCHIVE_TABLE = 'cloudfront_logs_archive';
export const ATHENA_WORKGROUP = 'traffic';
const HOSTING_KEY = 'hosting/asns.json';
export const GLUE_BOTS_TABLE = 'bot_ips';
export const GLUE_REPUTATION_TABLE = 'ip_reputation';
export const PARAMETER_PREFIX = '/traffic-monitor';
export const VISITOR_FUNCTION_NAME = 'dliu-visitor-id';
export const GEO_POLICY_NAME = 'dliu-traffic-geo';

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

// Extra standard logging (v2) fields, after the legacy ones: viewer country, viewer network (ASN) and
// the visitor ID the visitor-id function logs. Files from legacy logging read these as NULL.
export const ADDED_COLUMNS: Array<[string, string]> = [['c_country', 'string'], ['asn', 'string'], ['vid_log', 'string']];

// Standard logging (v2) is delivered under this prefix (see log-delivery-stack.ts).
export const V2_PREFIX = 'raw-v2';

export interface TrafficMonitorStackProps extends StackProps {
  /** Sites: key is the log prefix (raw/<key>/) and Athena partition; host is shown on the dashboard. */
  sites: { key: string; host: string }[];
  /** Subdomain for the dashboard, under the MainDomain export. */
  dashboardSubdomain?: string;
  /** Raw log retention. */
  retentionDays?: number;
}

export class TrafficMonitorStack extends Stack {
  readonly logBucket: s3.Bucket;

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
        { id: 'expire-log-archive', prefix: 'archive/', expiration: Duration.days(props.retentionDays ?? 365) },
        { id: 'expire-unprocessed-raw', prefix: 'raw/', expiration: Duration.days(7) },
        { id: 'expire-unprocessed-raw-v2', prefix: `${V2_PREFIX}/`, expiration: Duration.days(7) },
        { id: 'expire-bot-verdicts', prefix: 'bots/dt=', expiration: Duration.days(props.retentionDays ?? 365) },
        { id: 'expire-abuseipdb-results', prefix: 'reputation/', expiration: Duration.days(180) },
        { id: 'expire-abuseipdb-runs', prefix: 'abuseipdb/runs/', expiration: Duration.days(120) },
        { id: 'abort-multipart', abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
    });
    this.logBucket = logBucket;

    // Standard logging (v2) writes through CloudWatch Logs vended delivery, created in us-east-1.
    logBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AWSLogDeliveryWrite',
      principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [logBucket.arnForObjects(`${V2_PREFIX}/*`)],
      conditions: {
        StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control', 'aws:SourceAccount': this.account },
        ArnLike: { 'aws:SourceArn': `arn:aws:logs:us-east-1:${this.account}:delivery-source:*` },
      },
    }));
    logBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AWSLogDeliveryAclCheck',
      principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
      actions: ['s3:GetBucketAcl'],
      resources: [logBucket.bucketArn],
      conditions: {
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnLike: { 'aws:SourceArn': `arn:aws:logs:us-east-1:${this.account}:delivery-source:*` },
      },
    }));

    const partitioner = new lambda.Function(this, 'LogPartitioner', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(ROOT, 'lambda/partitioner')),
      timeout: Duration.seconds(60),
      memorySize: 512,
      description: 'Files CloudFront logs from raw/ and raw-v2/ into logs/site=<site>/dt=<day>/',
      logGroup: new logs.LogGroup(this, 'LogPartitionerLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    for (const prefix of ['raw', V2_PREFIX]) {
      logBucket.grantRead(partitioner, `${prefix}/*`);
      logBucket.grantDelete(partitioner, `${prefix}/*`);
      logBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(partitioner), { prefix: `${prefix}/` });
    }
    logBucket.grantPut(partitioner, 'logs/*');

    // ---------- Visitor cookie (attached by each site at viewer-response) ----------
    const visitorCode = fs.readFileSync(path.join(ROOT, 'functions/visitor-id.js'), 'utf8')
      .replace(/__COOKIE_DOMAIN__/g, () => rootDomain);
    const visitorFunction = new cloudfront.Function(this, 'VisitorIdFunction', {
      functionName: VISITOR_FUNCTION_NAME,
      comment: 'Sets the dl_vid visitor cookie for traffic monitoring',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(visitorCode),
    });
    // CloudFront only adds CloudFront-Viewer-City to a request (and so to the visitor function's
    // event) when a policy on the behavior names it. Sites attach this to their default behavior.
    // Not part of the cache key, so caching is unaffected.
    const geoPolicy = new cloudfront.OriginRequestPolicy(this, 'GeoOriginRequestPolicy', {
      originRequestPolicyName: GEO_POLICY_NAME,
      comment: 'Adds CloudFront-Viewer-City so the visitor function can log the city',
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('CloudFront-Viewer-City'),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
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
          'projection.site.values': props.sites.map((s) => s.key).join(','),
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
          columns: [...LOG_COLUMNS, ...ADDED_COLUMNS].map(([name, type]) => ({ name, type })),
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

    // Days the daily merge (compact.js) has finished with: one file per site and day, bots removed, in a folder
    // per month, archive/month=<YYYY-MM>/<site>_<day>.gz. Athena pays per folder it lists, so a 90-day query
    // lists about 4 month folders instead of 90 x sites day folders. site and dt are columns in the file.
    const archiveTable = new glue.CfnTable(this, 'LogsArchiveTable', {
      catalogId: this.account,
      databaseName: GLUE_DATABASE,
      tableInput: {
        name: GLUE_ARCHIVE_TABLE,
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          'skip.header.line.count': '2',
          'projection.enabled': 'true',
          'projection.month.type': 'date',
          'projection.month.format': 'yyyy-MM',
          'projection.month.range': '2026-01,NOW',
          'projection.month.interval': '1',
          'projection.month.interval.unit': 'MONTHS',
          'storage.location.template': `s3://${logBucket.bucketName}/archive/month=` + '${month}/',
        },
        partitionKeys: [{ name: 'month', type: 'string' }],
        storageDescriptor: {
          location: `s3://${logBucket.bucketName}/archive/`,
          columns: [...LOG_COLUMNS, ...ADDED_COLUMNS, ['site', 'string'], ['dt', 'string']].map(([name, type]) => ({ name, type })),
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
            parameters: { 'field.delim': '\t', 'serialization.format': '\t' },
          },
        },
      },
    });
    archiveTable.addResourceDependency(database);

    // JSON-lines tables written by the daily bot classifier (lambda/dashboard/bots.js), one folder per day.
    const jsonTable = (id: string, name: string, prefix: string, columns: Array<[string, string]>) => {
      const t = new glue.CfnTable(this, id, {
        catalogId: this.account,
        databaseName: GLUE_DATABASE,
        tableInput: {
          name,
          tableType: 'EXTERNAL_TABLE',
          parameters: {
            'projection.enabled': 'true',
            'projection.dt.type': 'date',
            'projection.dt.format': 'yyyy-MM-dd',
            'projection.dt.range': '2026-01-01,NOW',
            'projection.dt.interval': '1',
            'projection.dt.interval.unit': 'DAYS',
            'storage.location.template': `s3://${logBucket.bucketName}/${prefix}/dt=` + '${dt}/',
          },
          partitionKeys: [{ name: 'dt', type: 'string' }],
          storageDescriptor: {
            location: `s3://${logBucket.bucketName}/${prefix}/`,
            columns: columns.map(([colName, type]) => ({ name: colName, type })),
            inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
            outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
            serdeInfo: { serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe' },
          },
        },
      });
      t.addResourceDependency(database);
      return t;
    };
    jsonTable('BotIpsTable', GLUE_BOTS_TABLE, 'bots', [['ip', 'string'], ['reason', 'string']]);
    jsonTable('IpReputationTable', GLUE_REPUTATION_TABLE, 'reputation', [
      ['ip', 'string'], ['score', 'int'], ['reports', 'int'], ['usage_type', 'string'], ['isp', 'string'],
      ['domain', 'string'], ['is_tor', 'boolean'], ['checked', 'string'],
    ]);
    const glueResources = [
      this.formatArn({ service: 'glue', resource: 'catalog' }),
      this.formatArn({ service: 'glue', resource: 'database', resourceName: GLUE_DATABASE }),
      ...[GLUE_TABLE, GLUE_ARCHIVE_TABLE, GLUE_BOTS_TABLE, GLUE_REPUTATION_TABLE].map((name) =>
        this.formatArn({ service: 'glue', resource: 'table', resourceName: `${GLUE_DATABASE}/${name}` })),
    ];

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
        SITES: props.sites.map((s) => `${s.key}=${s.host}`).join(','),
        GLUE_DATABASE,
        GLUE_TABLE,
        GLUE_ARCHIVE_TABLE,
        GLUE_BOTS_TABLE,
        GLUE_REPUTATION_TABLE,
        ATHENA_WORKGROUP,
        PARAMETER_PREFIX,
        HOSTING_BUCKET: logBucket.bucketName,
        BOTS_BUCKET: logBucket.bucketName,
      },
      logGroup: new logs.LogGroup(this, 'DashboardLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    const workGroupArn = this.formatArn({ service: 'athena', resource: 'workgroup', resourceName: ATHENA_WORKGROUP });
    const athenaQuery = new iam.PolicyStatement({
      actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults', 'athena:StopQueryExecution'],
      resources: [workGroupArn],
    });
    const glueRead = new iam.PolicyStatement({
      actions: ['glue:GetDatabase', 'glue:GetTable', 'glue:GetPartition', 'glue:GetPartitions'],
      resources: glueResources,
    });
    dashboardHandler.addToRolePolicy(glueRead);
    dashboardHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters'],
      resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: PARAMETER_PREFIX.slice(1) + '/*' })],
    }));
    dashboardHandler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
    }));
    dashboardHandler.addToRolePolicy(athenaQuery);
    logBucket.grantRead(dashboardHandler, 'logs/*');
    logBucket.grantRead(dashboardHandler, 'archive/*');
    logBucket.grantRead(dashboardHandler, HOSTING_KEY);
    logBucket.grantRead(dashboardHandler, 'bots/*');
    logBucket.grantRead(dashboardHandler, 'reputation/*');
    resultsBucket.grantReadWrite(dashboardHandler);

    // Weekly refresh of the cloud/hosting network list (ASNs counted as bots) from public lists.
    const hostingUpdater = new lambda.Function(this, 'HostingListUpdater', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'hosting.update',
      code: lambda.Code.fromAsset(path.join(ROOT, 'lambda/dashboard')),
      timeout: Duration.seconds(60),
      memorySize: 256,
      description: 'Refreshes the hosting network (ASN) list the dashboard counts as bots',
      environment: { HOSTING_BUCKET: logBucket.bucketName },
      logGroup: new logs.LogGroup(this, 'HostingListUpdaterLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    logBucket.grantPut(hostingUpdater, HOSTING_KEY);
    new events.Rule(this, 'HostingListWeekly', {
      description: 'Refresh the hosting network list every Monday',
      schedule: events.Schedule.cron({ weekDay: 'MON', hour: '4', minute: '0' }),
      targets: [new eventTargets.LambdaFunction(hostingUpdater, { retryAttempts: 2 })],
    });

    // Daily bot classifier: per-day bot verdicts for each IP, with AbuseIPDB lookups (bots.js).
    const botClassifier = new lambda.Function(this, 'BotClassifier', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'bots.update',
      code: lambda.Code.fromAsset(path.join(ROOT, 'lambda/dashboard')),
      timeout: Duration.minutes(15),
      memorySize: 512,
      description: 'Judges which IPs were bots each day (hosting network, scanner, AbuseIPDB, headless)',
      environment: {
        GLUE_DATABASE,
        GLUE_TABLE,
        GLUE_ARCHIVE_TABLE,
        GLUE_BOTS_TABLE,
        GLUE_REPUTATION_TABLE,
        ATHENA_WORKGROUP,
        PARAMETER_PREFIX,
        HOSTING_BUCKET: logBucket.bucketName,
        BOTS_BUCKET: logBucket.bucketName,
      },
      logGroup: new logs.LogGroup(this, 'BotClassifierLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    botClassifier.addToRolePolicy(athenaQuery);
    botClassifier.addToRolePolicy(glueRead);
    botClassifier.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: PARAMETER_PREFIX.slice(1) + '/abuseipdb-api-key' })],
    }));
    botClassifier.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
    }));
    logBucket.grantRead(botClassifier, 'logs/*');
    logBucket.grantRead(botClassifier, HOSTING_KEY);
    logBucket.grantReadWrite(botClassifier, 'bots/*');
    logBucket.grantReadWrite(botClassifier, 'reputation/*');
    logBucket.grantPut(botClassifier, 'abuseipdb/runs/*');
    resultsBucket.grantReadWrite(botClassifier);
    new events.Rule(this, 'BotClassifierDaily', {
      description: 'Judge the last 3 days of IPs as bots or people, just after midnight UTC',
      schedule: events.Schedule.cron({ hour: '0', minute: '30' }),
      targets: [new eventTargets.LambdaFunction(botClassifier, { retryAttempts: 2 })],
    });
    // The dashboard's "Check bots now" button starts a run and reads its status.
    botClassifier.grantInvoke(dashboardHandler);
    logBucket.grantPut(dashboardHandler, 'bots/status.json');
    dashboardHandler.addEnvironment('BOTS_FUNCTION', botClassifier.functionName);
    // The /abuse-check page reads the AbuseIPDB run history.
    logBucket.grantRead(dashboardHandler, 'abuseipdb/*');
    logBucket.grantRead(dashboardHandler, 'reputation/*');

    // Daily log merge (compact.js): once the bot check has finished with a day (after 3 days), that day's
    // files become one file per site in archive/month=<YYYY-MM>/ and bots' requests are deleted. Athena is
    // paid per file it reads and per folder it lists. It writes only archive/* and deletes only logs/*.
    const logMerge = new lambda.Function(this, 'LogMerge', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'compact.update',
      code: lambda.Code.fromAsset(path.join(ROOT, 'lambda/dashboard')),
      timeout: Duration.minutes(15),
      memorySize: 1024,
      description: 'Merges each site\'s day of logs into one file and deletes bots\' requests, after the bot check',
      environment: {
        SITES: props.sites.map((s) => `${s.key}=${s.host}`).join(','),
        LOGS_BUCKET: logBucket.bucketName,
      },
      logGroup: new logs.LogGroup(this, 'LogMergeLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    logBucket.grantRead(logMerge, 'logs/*');
    logBucket.grantDelete(logMerge, 'logs/*');
    logBucket.grantRead(logMerge, 'bots/*');
    logBucket.grantRead(logMerge, 'archive/*');
    logBucket.grantPut(logMerge, 'archive/*');
    new events.Rule(this, 'LogMergeDaily', {
      description: 'Merge the logs of days the bot check has finished with',
      schedule: events.Schedule.cron({ hour: '1', minute: '30' }),
      targets: [new eventTargets.LambdaFunction(logMerge, { retryAttempts: 2 })],
    });

    const functionUrl = dashboardHandler.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    const siteBucket = new s3.Bucket(this, 'DashboardBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Public statistics: totals only, pre-computed into stats/<range>.json in the dashboard bucket, so
    // visitors who are not signed in read static files and never start an Athena query (public-stats.js).
    const publicStats = new lambda.Function(this, 'PublicStats', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'public-stats.update',
      code: lambda.Code.fromAsset(path.join(ROOT, 'lambda/dashboard')),
      timeout: Duration.minutes(5),
      memorySize: 512,
      description: 'Writes the public traffic totals (no IPs or visitor IDs) to the dashboard bucket',
      environment: {
        SITES: props.sites.map((s) => `${s.key}=${s.host}`).join(','),
        GLUE_DATABASE,
        GLUE_TABLE,
        GLUE_ARCHIVE_TABLE,
        GLUE_BOTS_TABLE,
        GLUE_REPUTATION_TABLE,
        ATHENA_WORKGROUP,
        STATS_BUCKET: siteBucket.bucketName,
      },
      logGroup: new logs.LogGroup(this, 'PublicStatsLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    publicStats.addToRolePolicy(athenaQuery);
    publicStats.addToRolePolicy(glueRead);
    logBucket.grantRead(publicStats, 'logs/*');
    logBucket.grantRead(publicStats, 'archive/*');
    logBucket.grantRead(publicStats, 'bots/*');
    resultsBucket.grantReadWrite(publicStats);
    siteBucket.grantPut(publicStats, 'stats/*');
    // Guests see 7, 30 and 90 whole days ending yesterday, refreshed once a day after the bot check (00:30)
    // and the log merge (01:30). Athena is paid per log file read, so a daily refresh costs cents a month.
    new events.Rule(this, 'PublicStatsDaily', {
      description: 'Refresh the public traffic totals (7d, 30d, 90d)',
      schedule: events.Schedule.cron({ hour: '2', minute: '0' }),
      targets: [new eventTargets.LambdaFunction(publicStats, {
        retryAttempts: 1,
        event: events.RuleTargetInput.fromObject({ ranges: ['7d', '30d', '90d'] }),
      })],
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
        customHeaders: [
          { header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true },
          { header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()', override: true },
          { header: 'Cross-Origin-Opener-Policy', value: 'same-origin', override: true },
        ],
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

    const pagesFunction = new cloudfront.Function(this, 'DashboardPagesFunction', {
      comment: 'Serves the dashboard pages (/about, /bots, /site...) from their .html files',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromFile({ filePath: path.join(ROOT, 'functions/dashboard-pages.js') }),
    });

    const distribution = new cloudfront.Distribution(this, 'DashboardDistribution', {
      comment: 'traffic dashboard',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
        functionAssociations: [{ function: pagesFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        // POST is used only by /api/bots/run; the Lambda answers 405 to other non-GET calls.
        'api/*': { ...lambdaBehavior, allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL },
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
      // The public statistics are written by the PublicStats function; a deploy must not delete them.
      exclude: ['stats/*'],
      // Browsers revalidate on every load (a 304 when unchanged), so a deploy shows up at once.
      cacheControl: [s3deploy.CacheControl.noCache()],
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
    new CfnOutput(this, 'TrafficGeoOriginRequestPolicyId', {
      value: geoPolicy.originRequestPolicyId,
      exportName: 'TrafficGeoOriginRequestPolicyId',
      description: 'Origin request policy to attach on each site default behavior so the visitor function can log the city.',
    });
    new CfnOutput(this, 'DashboardUrl', { value: siteUrl });
    new CfnOutput(this, 'AuthRedirectUri', { value: Fn.join('', [siteUrl, '/auth/callback']) });
    new CfnOutput(this, 'AthenaWorkGroup', { value: workGroup.name });
    new CfnOutput(this, 'DashboardFunctionName', { value: dashboardHandler.functionName });
    new CfnOutput(this, 'HostingListFunctionName', { value: hostingUpdater.functionName });
    new CfnOutput(this, 'BotClassifierFunctionName', { value: botClassifier.functionName });
    new CfnOutput(this, 'PublicStatsFunctionName', { value: publicStats.functionName });
    new CfnOutput(this, 'LogMergeFunctionName', { value: logMerge.functionName });
  }
}
