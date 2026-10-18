export class ItemService {
    items: any[] = [];
    constructor() {}
    setItems(items: any[]) {
        this.items = items;
    }
    getItems() {
        return this.items;
    }
}