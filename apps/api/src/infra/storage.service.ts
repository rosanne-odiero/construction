import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { describeError } from "../common/errors.js";
import { AppConfig } from "../config/app-config.js";

/**
 * S3-compatible object storage behind one service (the StorageProvider abstraction, ARCHITECTURE §20).
 * Locally this is RustFS; in the cloud it is S3 or a compatible service. Buckets are private.
 */
@Injectable()
export class StorageService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client;
  readonly bucket: string;

  constructor(private readonly config: AppConfig) {
    this.bucket = config.get("S3_BUCKET");
    this.s3 = new S3Client({
      endpoint: config.get("S3_ENDPOINT"),
      region: config.get("S3_REGION"),
      forcePathStyle: config.get("S3_FORCE_PATH_STYLE"),
      maxAttempts: 2,
      credentials: {
        accessKeyId: config.get("S3_ACCESS_KEY_ID"),
        secretAccessKey: config.get("S3_SECRET_ACCESS_KEY"),
      },
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get("S3_AUTO_CREATE_BUCKET")) return;
    try {
      await this.ensureBucket();
    } catch (error) {
      this.logger.warn(`Could not ensure bucket "${this.bucket}": ${describeError(error)}`);
    }
  }

  async ping(signal?: AbortSignal): Promise<void> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: signal });
  }

  private async ensureBucket(): Promise<void> {
    try {
      await this.ping();
    } catch (error) {
      const notFound =
        error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404;
      if (!notFound) throw error;
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Created development bucket "${this.bucket}"`);
    }
  }

  onModuleDestroy(): void {
    this.s3.destroy();
  }
}
