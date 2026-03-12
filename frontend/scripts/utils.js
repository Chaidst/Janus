class IndicatorLight {
    // this reminds me of the meme "What Is My Purpose?"
    status = false;
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
        this.setStatus("inactive");
    }

    /**
     * @param {"inactive"|"pending"|"active"} status
     */
    setStatus(status) {
        this.status = status;
        if (status === "inactive") {
            this.indicator.style.backgroundColor = "#ff1000";
        } else if (status === "pending") {
            this.indicator.style.backgroundColor = "#ffcc00";
        } else if (status === "active") {
            this.indicator.style.backgroundColor = "#00ff00";
        }
    }
}

export { IndicatorLight };