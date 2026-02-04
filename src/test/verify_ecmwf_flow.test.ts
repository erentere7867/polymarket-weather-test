import { HybridWeatherController } from '../realtime/hybrid-weather-controller.js';
import { DashboardController } from '../web/dashboard-controller.js';
import { EventBus } from '../realtime/event-bus.js';
import { DataStore } from '../realtime/data-store.js';
import { ForecastStateMachine } from '../realtime/forecast-state-machine.js';
import { S3FileDetector } from '../weather/s3-file-detector.js';
import { GRIB2Parser } from '../weather/grib2-parser.js';
import { ModelType, Coordinates } from '../weather/types.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

// Mock dependencies
jest.mock('../weather/s3-file-detector.js');
jest.mock('../weather/grib2-parser.js');
jest.mock('../logger.js');
jest.mock('../config.js', () => ({
    config: {
        ENABLE_FILE_BASED_INGESTION: true,
        FETCH_MODE_TIMEOUT_MINUTES: 10,
        NO_CHANGE_EXIT_MINUTES: 5,
        S3_POLL_INTERVAL_MS: 150,
        API_FALLBACK_MAX_DURATION_MINUTES: 5,
        openWeatherApiKey: 'dummy-key',
        tomorrowApiKey: 'dummy-key',
        weatherApiKey: 'dummy-key',
        weatherbitApiKey: 'dummy-key',
        visualCrossingApiKey: 'dummy-key',
        meteosourceApiKey: 'dummy-key',
        noaaHost: 'dummy-host',
        pollIntervalMs: 1000,
        forecastPollIntervalMs: 1000,
        logLevel: 'info',
        S3_DETECTOR_REGION: 'us-east-1',
        S3_DETECTOR_BUCKETS: '[]',
        ENABLE_ADAPTIVE_DETECTION_WINDOWS: true,
        ADAPTIVE_WINDOW_MIN_OBSERVATIONS: 5,
        ADAPTIVE_WINDOW_STD_DEV_FACTOR: 1.0,
        EARLY_DETECTION_CONFIDENCE_THRESHOLD: 0.7,
        EARLY_DETECTION_MAX_DURATION_MS: 300000
    }
}));

describe('ECMWF Flow Verification', () => {
    let eventBus: EventBus;
    let dataStore: DataStore;
    let stateMachine: ForecastStateMachine;
    let hybridController: HybridWeatherController;
    let dashboardController: DashboardController;

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Mock logger to console for debug visibility if needed
        (logger.info as jest.Mock).mockImplementation((msg) => console.log(`[Logger Info]: ${msg}`));
        (logger.warn as jest.Mock).mockImplementation((msg) => console.log(`[Logger Warn]: ${msg}`));
        (logger.error as jest.Mock).mockImplementation((msg) => console.log(`[Logger Error]: ${msg}`));
        
        // Reset EventBus singleton
        EventBus.resetInstance();
        eventBus = EventBus.getInstance();

        dataStore = new DataStore();
        stateMachine = new ForecastStateMachine();

        hybridController = new HybridWeatherController(stateMachine, dataStore);
        dashboardController = new DashboardController(dataStore);
    });

    test('Full ECMWF Pipeline Verification', async () => {
        const londonCoords: Coordinates = { lat: 51.5074, lon: -0.1278 };
        const mockEcmwfPayload = {
            model: 'ECMWF' as ModelType,
            cycleHour: 0,
            forecastHour: 24,
            cityData: [{
                cityName: 'London',
                coordinates: londonCoords,
                temperatureC: 15,
                temperatureF: 59,
                windSpeedMps: 5,
                windSpeedMph: 11.18,
                windDirection: 180,
                precipitationRateMmHr: 0,
                totalPrecipitationMm: 0,
                totalPrecipitationIn: 0
            }],
            timestamp: new Date(),
            source: 'FILE' as const,
            detectionLatencyMs: 100,
            downloadTimeMs: 50,
            parseTimeMs: 20,
            fileSize: 1024
        };

        console.log('STEP 1: Triggering ECMWF File Confirmation...');
        eventBus.emit({
            type: 'FILE_CONFIRMED',
            payload: mockEcmwfPayload
        });

        await new Promise(resolve => setTimeout(resolve, 200));

        console.log('STEP 2: Verifying HybridWeatherController State...');
        const cityUpdateStates = (hybridController as any).cityUpdateStates as Map<string, any>;
        const londonState = cityUpdateStates.get('london');
        
        expect(londonState).toBeDefined();
        expect(londonState.lastUpdateSource).toBe('ECMWF');
        console.log('✅ HybridWeatherController: lastUpdateSource is ECMWF');

        console.log('STEP 3: Verifying DashboardController Status...');
        const modelStatus = dashboardController.getModelStatus();
        const ecmwfStatus = modelStatus.find((m: any) => m.model === 'ECMWF');
        expect(ecmwfStatus).toBeDefined();
        expect(ecmwfStatus?.status).toBe('CONFIRMED');
        console.log('✅ DashboardController: ECMWF status is CONFIRMED');

        console.log('STEP 4: Verifying Arbitration Logic (GFS Rejection)...');
        const mockGfsPayload = {
            ...mockEcmwfPayload,
            model: 'GFS' as ModelType,
            timestamp: new Date(mockEcmwfPayload.timestamp.getTime() + 2 * 60 * 1000)
        };

        eventBus.emit({
            type: 'FILE_CONFIRMED',
            payload: mockGfsPayload
        });
        
        await new Promise(resolve => setTimeout(resolve, 200));

        const newLondonState = ((hybridController as any).cityUpdateStates as Map<string, any>).get('london');
        expect(newLondonState.lastUpdateSource).toBe('ECMWF');
        console.log('✅ Arbitration: Subsequent GFS update rejected (Source remains ECMWF)');
    });
});
