import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client as AwsS3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ConfigClient } from "../config-client/configClient.ts";

let client: AwsS3Client | undefined;

function getClient(): AwsS3Client {
  if (!client) {
    client = new AwsS3Client({ region: ConfigClient.Aws.region });
  }
  return client;
}

// Cached line audio is served back via a signed URL rather than a direct
// client-to-S3 path, per docs/BE_PLAN.md §2.
const SIGNED_URL_TTL_SECONDS = 3600;

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null &&
    ((err as { name?: string }).name === "NotFound" ||
      (err as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode === 404);
}

/** Generic bucket/key wrapper, bucket is passed in per call so this is
 * reusable across features (Polly cache now, session recordings later). */
export const S3Client = {
  async objectExists(bucket: string, key: string): Promise<boolean> {
    try {
      await getClient().send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  },

  async putObject(
    bucket: string,
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  },

  async getSignedGetUrl(bucket: string, key: string): Promise<string> {
    return await getSignedUrl(
      getClient(),
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: SIGNED_URL_TTL_SECONDS },
    );
  },
};
