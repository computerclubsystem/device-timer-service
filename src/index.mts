import { DeviceTimerService } from './device-timer-service.mjs';
import { Logger } from './logger.mjs';

const deviceTimerService = new DeviceTimerService();
const started = await deviceTimerService.start();
if (!started) {

}