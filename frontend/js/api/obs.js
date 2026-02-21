// OBS API Service - communicates via STP Gateway
const ObsAPI = {
  scenesLoaded: false,
  state: {
    connected: false,
    streaming: false,
    recording: false,
    currentScene: '',
    scenes: [],
    currentCameraIP: '',
    currentCameraName: ''
  },

  init(config) {
    this.cameraMap = config?.ptzCameras || {};
    this.tabletId = localStorage.getItem('tabletId') || 'WebApp';
  },

  async sendCommand(endpoint, payload = '') {
    const url = `/api/obs${endpoint}`;
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tablet-ID': this.tabletId,
      },
      body: payload ? JSON.stringify(payload) : '',
      signal: AbortSignal.timeout(10000),
    };

    try {
      const resp = await fetch(url, options);
      return await resp.json();
    } catch (e) {
      console.error('OBS:', e);
      return null;
    }
  },

  async poll() {
    const version = await this.sendCommand('/call/GetVersion', '');
    if (!version || !version.requestResult) {
      this.state.connected = false;
      return this.state;
    }
    this.state.connected = true;

    const [streamStatus, programScene, recordStatus] = await Promise.all([
      this.sendCommand('/call/GetStreamStatus', ''),
      this.sendCommand('/call/GetCurrentProgramScene', ''),
      this.sendCommand('/call/GetRecordStatus', '')
    ]);

    if (streamStatus?.requestResult) {
      this.state.streaming = streamStatus.requestResult.responseData.outputActive;
    }
    if (programScene?.requestResult) {
      this.state.currentScene = programScene.requestResult.responseData.currentProgramSceneName;
      this._mapSceneToCamera();
    }
    if (recordStatus?.requestResult) {
      this.state.recording = recordStatus.requestResult.responseData.outputActive;
    }

    if (!this.scenesLoaded) {
      const sceneList = await this.sendCommand('/call/GetSceneList', '');
      if (sceneList?.requestResult) {
        const scenes = sceneList.requestResult.responseData.scenes;
        scenes.reverse();
        this.state.scenes = scenes.slice(0, 16).map((s, i) => ({ index: i + 1, name: s.sceneName }));
        this.scenesLoaded = true;
      }
    }
    return this.state;
  },

  _mapSceneToCamera() {
    const camKeys = Object.keys(this.cameraMap || {});
    const camKey = camKeys.find(k => k === this.state.currentScene || this.state.currentScene.includes(k));
    if (camKey && this.cameraMap[camKey]) {
      this.state.currentCameraIP = this.cameraMap[camKey].ip;
      this.state.currentCameraName = this.cameraMap[camKey].name;
    }
  },

  async setScene(sceneNum) {
    const scene = this.state.scenes.find(s => s.index === sceneNum);
    if (scene) {
      await this.sendCommand('/emit/SetCurrentProgramScene', { sceneName: scene.name });
      await this.poll();
    }
  },

  async startStream() { await this.sendCommand('/emit/StartStream', ''); await this.poll(); },
  async stopStream() { await this.sendCommand('/emit/StopStream', ''); await this.poll(); },
  async startRecord() { await this.sendCommand('/emit/StartRecord', ''); await this.poll(); },
  async stopRecord() { await this.sendCommand('/emit/StopRecord', ''); await this.poll(); },

  async toggleSlides() {
    await this.sendCommand('/emit/CallVendorRequest', {
      vendorName: 'AdvancedSceneSwitcher', requestType: 'AdvancedSceneSwitcherMessage',
      requestData: { message: 'toggleSlides' }
    });
  },
  async slidesOn() {
    await this.sendCommand('/emit/CallVendorRequest', {
      vendorName: 'AdvancedSceneSwitcher', requestType: 'AdvancedSceneSwitcherMessage',
      requestData: { message: 'slidesOn' }
    });
  },
  async slidesOff() {
    await this.sendCommand('/emit/CallVendorRequest', {
      vendorName: 'AdvancedSceneSwitcher', requestType: 'AdvancedSceneSwitcherMessage',
      requestData: { message: 'slidesOff' }
    });
  },
  async resetLiveStream() {
    await this.sendCommand('/emit/CallVendorRequest', {
      vendorName: 'AdvancedSceneSwitcher', requestType: 'AdvancedSceneSwitcherMessage',
      requestData: { message: 'resetLiveStream' }
    });
  },
  async projectorAllOn() {
    await this.sendCommand('/emit/CallVendorRequest', {
      vendorName: 'AdvancedSceneSwitcher', requestType: 'AdvancedSceneSwitcherMessage',
      requestData: { message: 'projectorAllOn' }
    });
  },
  async projectorAllOff() {
    await this.sendCommand('/emit/CallVendorRequest', {
      vendorName: 'AdvancedSceneSwitcher', requestType: 'AdvancedSceneSwitcherMessage',
      requestData: { message: 'projectorAllOff' }
    });
  },
  async setAudioToShureMic() {
    await this.sendCommand('/emit/CallVendorRequest', {
      vendorName: 'AdvancedSceneSwitcher', requestType: 'AdvancedSceneSwitcherMessage',
      requestData: { message: 'setAudioToShureMic' }
    });
  },
  async reEnableBMATEMWebcam() {
    await this.sendCommand('/emit/CallVendorRequest', {
      vendorName: 'AdvancedSceneSwitcher', requestType: 'AdvancedSceneSwitcherMessage',
      requestData: { message: 'reEnableBMATEMWebcam' }
    });
  },

  // Called by Socket.IO state push
  onStateUpdate(data) {
    if (!data) return;
    if (data.healthy !== undefined) {
      this.state.connected = data.healthy;
      if (data.data) {
        this.state.streaming = data.data.streaming;
        this.state.recording = data.data.recording;
        this.state.currentScene = data.data.current_scene || '';
        this._mapSceneToCamera();
      }
    }
  }
};
