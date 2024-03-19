import { DeviceTimerService } from './device-timer-service.mjs';

const deviceTimerService = new DeviceTimerService();
await deviceTimerService.start();
