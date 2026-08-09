"""冒泡排序（Bubble Sort）"""


def bubble_sort(arr):
    """
    对列表进行冒泡排序（升序）。

    原理：每一轮从头到尾两两比较相邻元素，
    如果顺序错误（前 > 后）就交换，这样每轮结束后
    最大的元素会像气泡一样"冒"到末尾。

    参数:
        arr: 待排序的列表（会原地修改）

    返回:
        排序后的同一个列表
    """
    n = len(arr)
    for i in range(n - 1):          # 外循环：共 n-1 轮
        swapped = False             # 优化标记：本轮是否发生过交换
        for j in range(n - 1 - i):  # 内循环：已排好的尾部无需再比较
            if arr[j] > arr[j + 1]:
                arr[j], arr[j + 1] = arr[j + 1], arr[j]  # 交换
                swapped = True
        if not swapped:             # 本轮无交换 => 已有序，提前结束
            break
    return arr


if __name__ == "__main__":
    data = [64, 34, 25, 12, 22, 11, 90]
    print("排序前:", data)
    bubble_sort(data)
    print("排序后:", data)
