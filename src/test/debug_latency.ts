
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

// Mock GRIB2Parser for now to avoid dependency issues in this standalone script
// We are mainly interested in download latency.
// However, to be accurate to the "Parse it" requirement, we will try to simulate parsing delay
// or import the real one if we can.
// Let's import the real one but be ready to fallback.
import { GRIB2Parser } from '../weather/grib2-parser.js';

const REGION = 'us-east-1';

// Initialize S3 Client (Public Access)
const s3Client = new S3Client({
    region: REGION,
    credentials: {
        accessKeyId: '',
        secretAccessKey: '',
    },
    signer: { sign: async (request) => request },
});

const parser = new GRIB2Parser();

// Utility: Stream to Buffer
async function streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

// Utility: Format Date
function format(date: Date, fmt: string): string {
    const YYYY = date.getUTCFullYear();
    const MM = String(date.getUTCMonth() + 1).padStart(2, '0');
    const DD = String(date.getUTCDate()).padStart(2, '0');
    const HH = String(date.getUTCHours()).padStart(2, '0');
    
    return fmt.replace('{YYYY}', String(YYYY))
              .replace('{MM}', MM)
              .replace('{DD}', DD)
              .replace('{HH}', HH)
              .replace('{YYYYMMDD}', `${YYYY}${MM}${DD}`);
}

async function findRecentFile(bucket: string): Promise<{ key: string, date: Date, cycleHour: number } | null> {
    const now = new Date();
    // Check up to 24 hours back, every 6 hours
    for (let i = 0; i < 4; i++) {
        const testDate = new Date(now.getTime() - (i * 6 * 60 * 60 * 1000));
        // Round to previous 00, 06, 12, 18
        const cycleHour = Math.floor(testDate.getUTCHours() / 6) * 6;
        testDate.setUTCHours(cycleHour, 0, 0, 0);

        const dateStr = format(testDate, '{YYYYMMDD}');
        const hourStr = String(cycleHour).padStart(2, '0');
        const key = `gfs.${dateStr}/${hourStr}/atmos/gfs.t${hourStr}z.pgrb2.0p25.f003`;

        try {
            await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
            console.log(`Found file: s3://${bucket}/${key}`);
            return { key, date: testDate, cycleHour };
        } catch (e) {
            console.log(`Not found: s3://${bucket}/${key}`);
        }
    }
    return null;
}

async function benchmark() {
    console.log('Starting Latency Benchmark...');

    const bucket = 'noaa-gfs-bdp-pds';
    const fileInfo = await findRecentFile(bucket);

    if (!fileInfo) {
        console.error('Could not find a recent GFS file to test with.');
        return;
    }

    const { key: keyBase, cycleHour } = fileInfo;

    // --- FULL DOWNLOAD BENCHMARK ---
    console.log('\n--- Full Download Benchmark ---');
    const startFull = Date.now();
    let fullBuffer: Buffer;
    try {
        const fullFileResponse = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: keyBase }));
        fullBuffer = await streamToBuffer(fullFileResponse.Body as Readable);
    } catch (e) {
        console.error("Failed to download full file", e);
        return;
    }
    const downloadFullTime = Date.now() - startFull;
    console.log(`Full Download Time: ${downloadFullTime}ms`);
    console.log(`File Size: ${(fullBuffer.length / 1024 / 1024).toFixed(2)} MB`);

    const startParse = Date.now();
    try {
        await parser.parse(fullBuffer, { model: 'GFS', cycleHour, forecastHour: 3 });
    } catch (e) {
        console.warn("Parsing failed (might be expected if wgrib2 not installed):", e);
    }
    const parseTime = Date.now() - startParse;
    console.log(`Parse Time: ${parseTime}ms`);
    console.log(`Total "Full" Latency: ${downloadFullTime + parseTime}ms`);


    // --- SMART DOWNLOAD BENCHMARK ---
    console.log('\n--- Smart Download Benchmark ---');
    const idxKey = `${keyBase}.idx`;
    
    // 1. Download Index
    const startSmart = Date.now();
    let idxBody: string;
    try {
        const idxResponse = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: idxKey }));
        const idxBuffer = await streamToBuffer(idxResponse.Body as Readable);
        idxBody = idxBuffer.toString('utf-8');
    } catch (e) {
        console.log('No .idx file found. Smart download not possible.');
        return;
    }
    const idxTime = Date.now() - startSmart;
    console.log(`Index Download Time: ${idxTime}ms`);

    // 2. Parse Index to find ranges
    const lines = idxBody.split('\n');
    const ranges: { name: string, start: number, length: number }[] = [];
    
    // Check what variables we want. Usually TMP at 2m, maybe PRATE
    const wantedVars = [':TMP:2 m above ground:', ':PRATE:surface:'];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const v of wantedVars) {
            if (line.includes(v)) {
                // Format: 583:33306898:d=2023092506:TMP:2 m above ground:3 hour fcst:
                const parts = line.split(':');
                const startByte = parseInt(parts[1]);
                
                // Find end byte from next line
                let endByte = -1;
                if (i + 1 < lines.length) {
                    const nextParts = lines[i+1].split(':');
                    endByte = parseInt(nextParts[1]);
                } else {
                    // Last line... estimate
                    endByte = startByte + 100000; 
                }
                
                ranges.push({ name: v, start: startByte, length: endByte - startByte });
            }
        }
    }

    if (ranges.length === 0) {
        console.log('Could not find target variables in index.');
        return;
    }
    
    console.log(`Found ${ranges.length} ranges to download.`);

    // 3. Download Ranges
    const startRangeDownload = Date.now();
    let totalBytes = 0;
    
    // Download in parallel
    await Promise.all(ranges.map(async (range) => {
        const rangeHeader = `bytes=${range.start}-${range.start + range.length - 1}`;
        const rangeResp = await s3Client.send(new GetObjectCommand({ 
            Bucket: bucket, 
            Key: keyBase,
            Range: rangeHeader
        }));
        const chunk = await streamToBuffer(rangeResp.Body as Readable);
        totalBytes += chunk.length;
        // console.log(`Downloaded ${range.name}: ${chunk.length} bytes`);
    }));

    const rangeDownloadTime = Date.now() - startRangeDownload;
    
    console.log(`Range Download Time: ${rangeDownloadTime}ms`);
    console.log(`Total Bytes Downloaded: ${(totalBytes / 1024).toFixed(2)} KB`);
    console.log(`Total "Smart" Latency: ${idxTime + rangeDownloadTime}ms`);
    
    console.log(`\nLatency Reduction: ${((downloadFullTime + parseTime) - (idxTime + rangeDownloadTime))}ms`);
    console.log(`Speedup Factor: x${((downloadFullTime + parseTime) / (idxTime + rangeDownloadTime)).toFixed(1)}`);
}

benchmark().catch(console.error);
