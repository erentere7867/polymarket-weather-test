
import { ScheduleManager } from '../weather/schedule-manager.js';

async function verifyFixes() {
    console.log('Starting verification of RAP path and GFS configuration fixes...');

    const scheduleManager = new ScheduleManager();

    // 1. Verify RAP Path
    console.log('\n--- Verifying RAP Path ---');
    const testDate = new Date('2024-05-20T00:00:00Z');
    const cycleHour = 12; // 12z
    
    // Get expected file info for RAP
    // RAP config has detectionFile: 0, so we expect f00
    const rapFileInfo = scheduleManager.getExpectedFile('RAP', cycleHour, testDate);
    
    const expectedRapPath = 'rap.20240520/rap.t12z.awp130pgrb.f00.grib2';
    
    console.log(`Generated RAP Path: ${rapFileInfo.key}`);
    console.log(`Expected RAP Path:  ${expectedRapPath}`);
    
    if (rapFileInfo.key === expectedRapPath) {
        console.log('✅ RAP Path verification PASSED');
    } else {
        console.error('❌ RAP Path verification FAILED');
        console.error(`Expected: ${expectedRapPath}`);
        console.error(`Received: ${rapFileInfo.key}`);
        process.exit(1);
    }

    // 2. Verify GFS Window
    console.log('\n--- Verifying GFS Window ---');
    const gfsConfig = scheduleManager.getModelConfig('GFS');
    
    console.log(`GFS detectionWindowDurationMinutes: ${gfsConfig.detectionWindowDurationMinutes}`);
    
    if (gfsConfig.detectionWindowDurationMinutes === 120) {
        console.log('✅ GFS Window verification PASSED');
    } else {
        console.error('❌ GFS Window verification FAILED');
        console.error(`Expected: 120`);
        console.error(`Received: ${gfsConfig.detectionWindowDurationMinutes}`);
        process.exit(1);
    }

    console.log('\nAll verifications passed successfully!');
}

verifyFixes().catch(err => {
    console.error('Verification script error:', err);
    process.exit(1);
});
