import { PROJECTION_CONFIG } from './constants.js';

export default class Tools {
    constructor() {
        this.containerId = 'ar-container';
    }

    /**
     * Handles the 'project' tool call.
     * @param {Object} payload 
     */
    project(payload) {
        const { id, attach_point, relative_to, html } = payload;
        if (!id || !attach_point || !html) {
            console.error("Invalid 'project' payload:", payload);
            return;
        }
        const [x, y] = attach_point;
        const container = document.getElementById(this.containerId);
        if (!container) {
            console.error(`'${this.containerId}' not found!`);
            return;
        }
        
        let projection = document.getElementById(`projection-${id}`);
        if (!projection) {
            projection = document.createElement('div');
            projection.id = `projection-${id}`;
            projection.className = 'ar-projection';
            projection.style.position = 'absolute';
            projection.style.pointerEvents = 'auto'; // Allow interaction if needed
            container.appendChild(projection);
        }

        projection.innerHTML = html;
        
        // Position based on attach_point and relative_to
        this.updateProjectionPosition(projection, x, y, relative_to);
    }

    /**
     * Updates an existing projection's position.
     * @param {Object} payload 
     */
    updatePosition(payload) {
        const { id, attach_point, relative_to } = payload;
        const [x, y] = attach_point;
        const projection = document.getElementById(`projection-${id}`);
        if (projection) {
            this.updateProjectionPosition(projection, x, y, relative_to);
        }
    }

    /**
     * Updates the position of a projection element.
     */
    updateProjectionPosition(element, x, y, relativeTo) {
        const offset = PROJECTION_CONFIG.OFFSET; // Some padding from the attach point
        
        element.style.left = `${x}px`;
        element.style.top = `${y}px`;
        element.style.transform = 'translate(0, 0)'; // Default

        // Adjust based on relativeTo
        switch (relativeTo) {
            case 'top':
                element.style.transform = `translate(-50%, calc(-100% - ${offset}px))`;
                break;
            case 'bottom':
                element.style.transform = `translate(-50%, ${offset}px)`;
                break;
            case 'left':
                element.style.transform = `translate(calc(-100% - ${offset}px), -50%)`;
                break;
            case 'right':
                element.style.transform = `translate(${offset}px, -50%)`;
                break;
            default:
                element.style.transform = 'translate(-50%, -50%)';
                break;
        }
    }

    /**
     * Handles the 'unproject' tool call.
     * @param {Object} payload 
     */
    unproject(payload) {
        const { id } = payload;
        const container = document.getElementById(this.containerId);
        if (!container) return;
        
        // Exact match
        let element = document.getElementById(`projection-${id}`);
        
        if (!element) {
            // Fuzzy match
            const projections = container.getElementsByClassName('ar-projection');
            for (let proj of projections) {
                const projId = proj.id.replace('projection-', '');
                if (this.isSimilar(projId, id)) {
                    element = proj;
                    break;
                }
            }
        }

        if (element) {
            element.remove();
        }
    }

    /**
     * Simple fuzzy match based on similarity (e.g., Levenshtein distance or just substring).
     * Using a simple distance check or partial match here.
     */
    isSimilar(s1, s2) {
        if (!s1 || !s2) return false;
        if (s1.toLowerCase() === s2.toLowerCase()) return true;
        
        // Check for common variations like -_ or spaces
        const norm1 = s1.toLowerCase().replace(/[-_ ]/g, '');
        const norm2 = s2.toLowerCase().replace(/[-_ ]/g, '');
        if (norm1 === norm2) return true;
        
        // If one is a substring of the other (with a minimum length)
        if (norm1.length > 3 && norm2.length > 3) {
            if (norm1.includes(norm2) || norm2.includes(norm1)) return true;
        }

        return false;
    }
}
