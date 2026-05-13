// Widget System (Unreal Engine Style)

export class WidgetManager {
    constructor(container) {
        this.container = container;
        this.widgets = new Map();
        this.nextId = 1;

        this.overlay = document.createElement('div');
        this.overlay.id = 'widget-overlay';
        this.overlay.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 1000;
        `;
        this.container.appendChild(this.overlay);
    }

    createWidget(type, config = {}) {
        const id = this.nextId++;
        let widget;

        switch (type) {
            case 'text':
                widget = new TextWidget(id, config);
                break;
            case 'image':
                widget = new ImageWidget(id, config);
                break;
            case 'progress':
                widget = new ProgressBarWidget(id, config);
                break;
            case 'button':
                widget = new ButtonWidget(id, config);
                break;
            default:
                throw new Error(`Unknown widget type: ${type}`);
        }

        this.widgets.set(id, widget);
        this.overlay.appendChild(widget.element);
        return id;
    }

    updateWidget(id, updates) {
        const widget = this.widgets.get(id);
        if (!widget) return false;
        widget.update(updates);
        return true;
    }

    showWidget(id, visible = true) {
        const widget = this.widgets.get(id);
        if (!widget) return false;
        widget.element.style.display = visible ? 'block' : 'none';
        return true;
    }

    removeWidget(id) {
        const widget = this.widgets.get(id);
        if (!widget) return false;
        this.overlay.removeChild(widget.element);
        widget.dispose();
        this.widgets.delete(id);
        return true;
    }

    setWidgetPosition(id, position, space = 'screen') {
        const widget = this.widgets.get(id);
        if (!widget) return false;

        if (space === 'screen') {
            const x = (position.x * 100) + '%';
            const y = (position.y * 100) + '%';
            widget.element.style.left = x;
            widget.element.style.top = y;
            widget.element.style.transform = 'translate(-50%, -50%)';
        } else {
            console.warn('World space positioning not yet implemented for HTML widgets');
        }
        return true;
    }

    setWidgetScale(id, scale) {
        const widget = this.widgets.get(id);
        if (!widget) return false;

        const scaleValue = typeof scale === 'number' ? scale : scale.x || 1;
        widget.element.style.transform = widget.element.style.transform.replace(/scale\([^)]*\)/, '') + ` scale(${scaleValue})`;
        return true;
    }

    getWidget(id) {
        return this.widgets.get(id);
    }

    getAllWidgets() {
        return Array.from(this.widgets.values());
    }

    update(delta) {
        // Kept to prevent breaking the main render loop
    }

    dispose() {
        for (const widget of this.widgets.values()) {
            widget.dispose();
        }
        this.widgets.clear();
        if (this.overlay && this.overlay.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
    }
}

export class BaseWidget {
    constructor(id, config = {}) {
        this.id = id;
        this.element = document.createElement('div');
        this.element.className = 'widget';
        this.element.style.cssText = `
            position: absolute;
            pointer-events: auto;
            user-select: none;
        `;

        this.config = {
            position: { x: 0.5, y: 0.5 },
            scale: 1,
            visible: true,
            zOrder: 0,
            ...config
        };

        this.updatePosition();
        this.element.style.display = this.config.visible ? 'block' : 'none';
        this.element.style.zIndex = String(this.config.zOrder);
    }

    update(updates) {
        if (updates.position) {
            this.config.position = updates.position;
            this.updatePosition();
        }
        if (updates.scale !== undefined) {
            this.config.scale = updates.scale;
            this.updateScale();
        }
        if (updates.visible !== undefined) {
            this.config.visible = updates.visible;
            this.element.style.display = updates.visible ? 'block' : 'none';
        }
        if (updates.zOrder !== undefined) {
            this.config.zOrder = updates.zOrder;
            this.element.style.zIndex = String(updates.zOrder);
        }

        Object.assign(this.config, updates);
    }

    updatePosition() {
        const x = (this.config.position.x * 100) + '%';
        const y = (this.config.position.y * 100) + '%';
        this.element.style.left = x;
        this.element.style.top = y;
        this.element.style.transform = 'translate(-50%, -50%)';
        this.updateScale();
    }

    updateScale() {
        const currentTransform = this.element.style.transform;
        const translateMatch = currentTransform.match(/translate\([^)]+\)/);
        const translate = translateMatch ? translateMatch[0] : 'translate(-50%, -50%)';
        this.element.style.transform = `${translate} scale(${this.config.scale})`;
    }

    dispose() {
        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
        }
    }
}

export class TextWidget extends BaseWidget {
    constructor(id, config = {}) {
        super(id, config);

        this.config = {
            text: 'Hello World',
            fontSize: 24,
            color: '#ffffff',
            fontFamily: 'Arial, sans-serif',
            textAlign: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            padding: '8px 16px',
            borderRadius: '4px',
            ...this.config
        };

        this.element.innerHTML = `
            <div style="
                font-size: ${this.config.fontSize}px;
                color: ${this.config.color};
                font-family: ${this.config.fontFamily};
                text-align: ${this.config.textAlign};
                background-color: ${this.config.backgroundColor};
                padding: ${this.config.padding};
                border-radius: ${this.config.borderRadius};
                white-space: nowrap;
            ">${this.config.text}</div>
        `;
    }

    update(updates) {
        super.update(updates);
        const inner = this.element.querySelector('div');

        if (updates.text !== undefined) {
            this.config.text = updates.text;
            inner.textContent = updates.text;
        }
        if (updates.fontSize !== undefined) {
            this.config.fontSize = updates.fontSize;
            inner.style.fontSize = updates.fontSize + 'px';
        }
        if (updates.color !== undefined) {
            this.config.color = updates.color;
            inner.style.color = updates.color;
        }
        if (updates.fontFamily !== undefined) {
            this.config.fontFamily = updates.fontFamily;
            inner.style.fontFamily = updates.fontFamily;
        }
        if (updates.textAlign !== undefined) {
            this.config.textAlign = updates.textAlign;
            inner.style.textAlign = updates.textAlign;
        }
        if (updates.backgroundColor !== undefined) {
            this.config.backgroundColor = updates.backgroundColor;
            inner.style.backgroundColor = updates.backgroundColor;
        }
        if (updates.padding !== undefined) {
            this.config.padding = updates.padding;
            inner.style.padding = updates.padding;
        }
        if (updates.borderRadius !== undefined) {
            this.config.borderRadius = updates.borderRadius;
            inner.style.borderRadius = updates.borderRadius;
        }
    }
}

export class ImageWidget extends BaseWidget {
    constructor(id, config = {}) {
        super(id, config);

        this.config = {
            imageUrl: null,
            width: 100,
            height: 100,
            ...this.config
        };

        this.element.innerHTML = `
            <img style="
                width: ${this.config.width}px;
                height: ${this.config.height}px;
                object-fit: contain;
                border-radius: 4px;
            " src="${this.config.imageUrl || ''}" alt="Widget Image">
        `;
    }

    update(updates) {
        super.update(updates);
        const img = this.element.querySelector('img');

        if (updates.imageUrl !== undefined) {
            this.config.imageUrl = updates.imageUrl;
            img.src = updates.imageUrl;
        }
        if (updates.width !== undefined) {
            this.config.width = updates.width;
            img.style.width = updates.width + 'px';
        }
        if (updates.height !== undefined) {
            this.config.height = updates.height;
            img.style.height = updates.height + 'px';
        }
    }
}

export class ProgressBarWidget extends BaseWidget {
    constructor(id, config = {}) {
        super(id, config);

        this.config = {
            progress: 0.5,
            width: 200,
            height: 20,
            backgroundColor: '#333333',
            fillColor: '#00ff00',
            borderColor: '#ffffff',
            borderWidth: '2px',
            borderRadius: '4px',
            ...this.config
        };

        this.element.innerHTML = `
            <div style="
                width: ${this.config.width}px;
                height: ${this.config.height}px;
                background-color: ${this.config.backgroundColor};
                border: ${this.config.borderWidth} solid ${this.config.borderColor};
                border-radius: ${this.config.borderRadius};
                overflow: hidden;
            ">
                <div style="
                    width: 100%;
                    height: 100%;
                    background-color: ${this.config.fillColor};
                    transform: scaleX(${Math.max(0, Math.min(1, this.config.progress))});
                    transform-origin: left center;
                    transition: transform 0.3s ease;
                "></div>
            </div>
        `;
    }

    update(updates) {
        super.update(updates);
        const outer = this.element.querySelector('div');
        const inner = this.element.querySelector('div > div');

        if (updates.progress !== undefined) {
            this.config.progress = Math.max(0, Math.min(1, updates.progress));
            inner.style.width = '100%';
            inner.style.transform = `scaleX(${this.config.progress})`;
            inner.style.transformOrigin = 'left center';
        }
        if (updates.width !== undefined) {
            this.config.width = updates.width;
            outer.style.width = updates.width + 'px';
        }
        if (updates.height !== undefined) {
            this.config.height = updates.height;
            outer.style.height = updates.height + 'px';
        }
        if (updates.backgroundColor !== undefined) {
            this.config.backgroundColor = updates.backgroundColor;
            outer.style.backgroundColor = updates.backgroundColor;
        }
        if (updates.fillColor !== undefined) {
            this.config.fillColor = updates.fillColor;
            inner.style.backgroundColor = updates.fillColor;
        }
        if (updates.borderColor !== undefined) {
            this.config.borderColor = updates.borderColor;
            outer.style.borderColor = updates.borderColor;
        }
        if (updates.borderWidth !== undefined) {
            this.config.borderWidth = updates.borderWidth;
            outer.style.borderWidth = updates.borderWidth;
        }
        if (updates.borderRadius !== undefined) {
            this.config.borderRadius = updates.borderRadius;
            outer.style.borderRadius = updates.borderRadius;
        }
    }
}

export class ButtonWidget extends BaseWidget {
    constructor(id, config = {}) {
        super(id, config);

        this.config = {
            text: 'Button',
            width: 120,
            height: 40,
            backgroundColor: '#444444',
            hoverColor: '#666666',
            textColor: '#ffffff',
            borderRadius: '4px',
            fontSize: 16,
            onClick: null,
            ...this.config
        };

        this.element.innerHTML = `
            <button style="
                width: ${this.config.width}px;
                height: ${this.config.height}px;
                background-color: ${this.config.backgroundColor};
                color: ${this.config.textColor};
                border: none;
                border-radius: ${this.config.borderRadius};
                font-size: ${this.config.fontSize}px;
                font-family: Arial, sans-serif;
                cursor: pointer;
                transition: background-color 0.2s ease;
            ">${this.config.text}</button>
        `;

        this.buttonElement = this.element.querySelector('button');
        this.buttonElement.addEventListener('click', () => {
            if (this.config.onClick) this.config.onClick(this.id);
        });
        this.buttonElement.addEventListener('mouseenter', () => {
            this.buttonElement.style.backgroundColor = this.config.hoverColor;
        });
        this.buttonElement.addEventListener('mouseleave', () => {
            this.buttonElement.style.backgroundColor = this.config.backgroundColor;
        });
    }

    update(updates) {
        super.update(updates);

        if (updates.text !== undefined) {
            this.config.text = updates.text;
            this.buttonElement.textContent = updates.text;
        }
        if (updates.width !== undefined) {
            this.config.width = updates.width;
            this.buttonElement.style.width = updates.width + 'px';
        }
        if (updates.height !== undefined) {
            this.config.height = updates.height;
            this.buttonElement.style.height = updates.height + 'px';
        }
        if (updates.backgroundColor !== undefined) {
            this.config.backgroundColor = updates.backgroundColor;
            this.buttonElement.style.backgroundColor = updates.backgroundColor;
        }
        if (updates.hoverColor !== undefined) {
            this.config.hoverColor = updates.hoverColor;
        }
        if (updates.textColor !== undefined) {
            this.config.textColor = updates.textColor;
            this.buttonElement.style.color = updates.textColor;
        }
        if (updates.borderRadius !== undefined) {
            this.config.borderRadius = updates.borderRadius;
            this.buttonElement.style.borderRadius = updates.borderRadius;
        }
        if (updates.fontSize !== undefined) {
            this.config.fontSize = updates.fontSize;
            this.buttonElement.style.fontSize = updates.fontSize + 'px';
        }
        if (updates.onClick !== undefined) {
            this.config.onClick = updates.onClick;
        }
    }
}
