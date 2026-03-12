// this reminds me of the meme "What Is My Purpose?"

class IndicatorLight {
    active = false;
    constructor() {
        this.indicator = document.createElement("div");
        this.indicator.style.position = "fixed";
        this.indicator.style.top = "10px";
        this.indicator.style.left = "10px";
        this.indicator.style.width = "10px";
        this.indicator.style.height = "10px";
        this.indicator.style.borderRadius = "100%";
        this.indicator.style.zIndex = "998";
        document.body.appendChild(this.indicator);
    }

    /**
     * @param {boolean} active
     */
    setActive(active) {
        this.active = active;
        if (this.active) {
            this.indicator.style.backgroundColor = "#00ff00";
        } else {
            this.indicator.style.backgroundColor = "#ff1000";
        }
    }
}

export default IndicatorLight;