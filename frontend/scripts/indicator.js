// this reminds me of the meme "What Is My Purpose?"

class IndicatorLight {
    constructor() {
        console.log("IndicatorLight constructor called");
        this.indicator = document.createElement("div");
        this.indicator.style.position = "fixed";
        this.indicator.style.top = "10px";
        this.indicator.style.left = "10px";
        this.indicator.style.width = "10px";
        this.indicator.style.height = "10px";
        this.indicator.style.borderRadius = "100%";
        this.indicator.style.zIndex = "998";
        this.indicator.style.backgroundColor = "#ff1000"; // Start with disconnected (red)
        document.body.appendChild(this.indicator);
    }

    setActive(active) {
        if (!active) {
            this.indicator.style.backgroundColor = "#ff1000"; // Red
        }
    }

    setConnected(connected) {
        if (connected) {
            this.indicator.style.backgroundColor = "#ffff00"; // Yellow
        }
    }

    setReady(ready) {
        if (ready) {
            this.indicator.style.backgroundColor = "#00ff00"; // Green
        }
    }
}

export default IndicatorLight;