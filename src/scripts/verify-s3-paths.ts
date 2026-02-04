import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const bucket = 'noaa-rap-pds';
const region = 'us-east-1';

const client = new S3Client({
    region,
    credentials: { accessKeyId: '', secretAccessKey: '' },
    signer: { sign: async (request) => request }
});

async function main() {
    console.log(`\n🔎 Checking RAP bucket for specifc grid types`);

    const now = new Date();
    // Check yesterday
    const checkDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const year = checkDate.getUTCFullYear();
    const month = String(checkDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(checkDate.getUTCDate()).padStart(2, '0');
    const yyyymmdd = `${year}${month}${day}`;

    // 1. Check for 13km grid (awp130pgrb)
    const awp130Prefix = `rap.${yyyymmdd}/rap.t00z.awp130pgrb`;
    console.log(`\n1️⃣ Checking for 13km grid: ${awp130Prefix}`);
    const awp130Cmd = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: awp130Prefix,
        MaxKeys: 5
    });

    try {
        const res = await client.send(awp130Cmd);
        if (res.Contents && res.Contents.length > 0) {
            console.log('✅ FOUND 13km RAP files!');
            res.Contents.forEach(c => console.log(`   - ${c.Key}`));
        } else {
            console.log('❌ NO 13km RAP files found.');
        }
    } catch (e: any) { console.log(e.message); }

    // 2. Check for 32km grid (awip32)
    const awip32Prefix = `rap.${yyyymmdd}/rap.t00z.awip32`;
    console.log(`\n2️⃣ Checking for 32km grid: ${awip32Prefix}`);
    const awip32Cmd = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: awip32Prefix,
        MaxKeys: 5
    });

    try {
        const res = await client.send(awip32Cmd);
        if (res.Contents && res.Contents.length > 0) {
            console.log('✅ FOUND 32km RAP files!');
            res.Contents.forEach(c => console.log(`   - ${c.Key}`));
        } else {
            console.log('❌ NO 32km RAP files found.');
        }
    } catch (e: any) { console.log(e.message); }
}

main().catch(console.error);
